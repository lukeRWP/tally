const productMatch = require('./lookup/product-match');
const ProductsService = require('./products.service');

let _db = null;
let _logger = null;
let _config = null;
let _search = null;

const MatchesService = {
  /** `searcher` is injectable so tests never reach the network. */
  init({ db, logger, config, searcher }) {
    _db = db;
    _logger = logger;
    _config = config;
    _search = searcher || ((input) => productMatch.search(input, { config, logger }));
    // Same rationale as ContainersService.init calling RecycleService.init:
    // resolve() reuses checkDuplicate's own membership-scoped query rather
    // than keep a second copy, and initializing it here means that works
    // regardless of whether products.routes has registered yet.
    ProductsService.init({ db, logger });
  },

  /**
   * Sums SEARCH_COUNT, not COUNT(*): a re-queue upserts the same row (the
   * UNIQUE on ITEM_ID) and fires another paid search without inserting a new
   * row, so counting rows undercounts the actual spend. Filters on
   * UPDATED_AT — the column a search attempt actually touches — rather than
   * CREATED_AT, so a search fired long after the row was first created still
   * lands in today's count.
   *
   * Shared by queue() (checked before a row is even inserted) and runNow()
   * (checked before every call — see the comment there for why the queue-time
   * check alone is not enough).
   */
  async countToday(userId) {
    const rows = await _db.query(
      `SELECT COALESCE(SUM(SEARCH_COUNT), 0) AS N FROM TALLY.product_matches
        WHERE CREATED_BY = ? AND UPDATED_AT > DATE_SUB(NOW(), INTERVAL 1 DAY)`,
      [userId]
    );
    return rows[0]?.N ?? 0;
  },

  /**
   * Queue a match for an item the caller owns.
   *
   * The gate (high confidence + a brand) is applied by the client, which is the
   * only place the vision confidence exists. Ownership is NOT advisory and is
   * checked here through the membership join, like every other read.
   */
  async queue({ itemId, brand, name, category, description }, userId) {
    // Same join chain as items.service.js's getRecent (~line 476): a soft
    // delete anywhere above the item — container, area, property — must hide
    // it the same way it hides the item itself, or a match can be queued
    // (spending against the daily cap) for an item that is no longer reachable.
    const owned = await _db.query(
      `SELECT i.ID
         FROM TALLY.items i
         JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
         JOIN TALLY.areas a ON c.AREA_ID = a.ID
         JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
         JOIN TALLY.property_members pm ON p.ID = pm.PROPERTY_ID
        WHERE i.ID = ? AND pm.USER_ID = ?
          AND i.DELETED_AT IS NULL
          AND c.DELETED_AT IS NULL
          AND a.DELETED_AT IS NULL
          AND p.DELETED_AT IS NULL`,
      [itemId, userId]
    );
    if (owned.length === 0) {
      const err = new Error('Item not found');
      err.status = 404;
      throw err;
    }

    if (await MatchesService.countToday(userId) >= _config.match.dailyPerUser) {
      const err = new Error('Daily product-match limit reached');
      err.status = 429;
      throw err;
    }

    const query = { brand: brand ?? null, name: name ?? null,
                    category: category ?? null, description: description ?? null };

    // ON DUPLICATE KEY: the UNIQUE on ITEM_ID makes a re-queue idempotent
    // rather than an error, which is what a retrying client should get.
    //
    // SEARCH_QUERY is always refreshed — a second attempt usually means
    // better information (a retaken photo, a corrected brand), and the old
    // query has no further use once a new one has arrived.
    //
    // STATUS, ATTEMPTS and LAST_ERROR only reset when the row is not already
    // 'resolved' or 'dismissed': someone already made a decision on this
    // match, and a re-queue must not quietly undo it. A row coming back to
    // 'queued' starts clean — carrying over a stale LAST_ERROR would show a
    // leftover "Couldn't look this up" on a match that is, as of this call,
    // freshly in progress. The CASE's STATUS reference reads the same whether
    // MySQL evaluates it against the row's pre- or post-assignment value in
    // this statement, because a terminal status always maps to itself and
    // every non-terminal status always maps to 'queued' — the predicate is
    // not order-sensitive.
    const res = await _db.query(
      `INSERT INTO TALLY.product_matches (ITEM_ID, CREATED_BY, STATUS, SEARCH_QUERY)
            VALUES (?, ?, 'queued', ?)
       ON DUPLICATE KEY UPDATE
         ID = LAST_INSERT_ID(ID),
         SEARCH_QUERY = VALUES(SEARCH_QUERY),
         STATUS = CASE WHEN STATUS IN ('resolved', 'dismissed') THEN STATUS ELSE 'queued' END,
         ATTEMPTS = CASE WHEN STATUS IN ('resolved', 'dismissed') THEN ATTEMPTS ELSE 0 END,
         LAST_ERROR = CASE WHEN STATUS IN ('resolved', 'dismissed') THEN LAST_ERROR ELSE NULL END`,
      [itemId, userId, JSON.stringify(query)]
    );

    // The row's real status, not a hardcoded 'queued' — a re-queue of an
    // already-resolved/dismissed row stays resolved/dismissed. Task 5's route
    // reads this to decide whether to fire the runner at all.
    const rows = await _db.query(
      `SELECT STATUS FROM TALLY.product_matches WHERE ID = ?`,
      [res.insertId]
    );
    return { id: res.insertId, status: rows[0].STATUS };
  },

  /**
   * Work one match to completion.
   *
   * Awaitable for tests, but called without await in the route — this is the
   * fire-and-forget runner. It NEVER rejects: a rejection from an unawaited
   * promise is an unhandled rejection, and there is no caller left to see it.
   *
   * There is deliberately no abort-on-disconnect wiring here. A `req.on('close')`
   * handler aborted every vision call at 0ms; this runner outlives its request
   * by design.
   */
  async runNow(matchId) {
    // Whether this run got as far as spending an attempt (the 'searching'
    // transition below). The catch block needs to know: a failure AFTER that
    // point must not double-increment ATTEMPTS, and a failure BEFORE it (the
    // initial read, or the cap check) still has to count as one.
    let attempted = false;
    try {
      const rows = await _db.query(
        `SELECT ID, SEARCH_QUERY, CREATED_BY FROM TALLY.product_matches WHERE ID = ?`, [matchId]
      );
      if (rows.length === 0) return;
      const input = typeof rows[0].SEARCH_QUERY === 'string'
        ? JSON.parse(rows[0].SEARCH_QUERY || '{}')
        : (rows[0].SEARCH_QUERY || {});

      // The daily cost cap is enforced here too, not only in queue(): this is
      // where the spend actually happens, and list()'s lazy batch retry (see
      // list() below) is a path into a search that never passes through
      // queue()'s own check. A capped run is terminal rather than left
      // 'queued' — otherwise it would be re-selected by that same batch retry
      // every time the worklist is read, forever, until the cap rolls over.
      if (await MatchesService.countToday(rows[0].CREATED_BY) >= _config.match.dailyPerUser) {
        await _db.query(
          `UPDATE TALLY.product_matches SET STATUS = 'failed', LAST_ERROR = ? WHERE ID = ?`,
          ['Daily product-match limit reached', matchId]
        );
        return;
      }

      // ATTEMPTS increments on EVERY attempt here, not only on failure (the
      // catch block below used to be the only place it moved) — otherwise the
      // cap is never reached on a run that keeps failing, 'failed' is
      // unreachable, and a queued row has no way to stop being retried.
      // SEARCH_COUNT increments in the same statement: it is what the daily
      // cost cap actually sums (countToday), and it has to move whether the
      // search below succeeds or throws — the cost is spent either way.
      await _db.query(
        `UPDATE TALLY.product_matches
            SET STATUS = 'searching', SEARCH_STARTED_AT = NOW(),
                ATTEMPTS = ATTEMPTS + 1, SEARCH_COUNT = SEARCH_COUNT + 1
          WHERE ID = ?`,
        [matchId]
      );
      attempted = true;

      const { candidates } = await _search(input);

      if (candidates.length === 0) {
        await _db.query(
          `UPDATE TALLY.product_matches SET STATUS = 'none', CANDIDATES = NULL WHERE ID = ?`,
          [matchId]
        );
        return;
      }
      await _db.query(
        `UPDATE TALLY.product_matches SET STATUS = 'ready', CANDIDATES = ? WHERE ID = ?`,
        [JSON.stringify(candidates), matchId]
      );
    } catch (err) {
      _logger?.warn('product match run failed', { matchId, error: err.message });
      try {
        // Back to 'queued' (list()'s lazy retry picks it up again) unless the
        // attempts cap is reached — one statement so the decision cannot
        // drift from the sweep's. If `attempted` is true, ATTEMPTS was already
        // bumped above and must not be bumped again; if false, this failure
        // happened before that point (e.g. the initial read) and still has to
        // count as an attempt, exactly as the pre-fix code always did.
        const sql = attempted
          ? `UPDATE TALLY.product_matches
                SET STATUS = CASE WHEN ATTEMPTS >= ? THEN 'failed' ELSE 'queued' END,
                    LAST_ERROR = ?
              WHERE ID = ?`
          : `UPDATE TALLY.product_matches
                SET STATUS = CASE WHEN ATTEMPTS + 1 >= ? THEN 'failed' ELSE 'queued' END,
                    ATTEMPTS = ATTEMPTS + 1,
                    LAST_ERROR = ?
              WHERE ID = ?`;
        await _db.query(sql, [_config.match.maxAttempts, String(err.message).slice(0, 500), matchId]);
      } catch (inner) {
        _logger?.error('could not record match failure', { matchId, error: inner.message });
      }
    }
  },

  /**
   * Lazy sweep, borrowed wholesale from print's sweepStaleClaims: a runner that
   * dies mid-search would otherwise strand its row in 'searching' forever, and
   * this app has nowhere to run a cron.
   *
   * Scoped to the property being listed, not global — product_matches has no
   * PROPERTY_ID column of its own, so the scope is reached through the same
   * items→containers→areas chain as every other query here, joined into the
   * UPDATE. An unscoped sweep across every user's rows on every worklist GET
   * has no reason to exist.
   *
   * Only reaches 'searching'. A row a runner set back to 'queued' after a
   * failure is NOT this sweep's job — see list()'s own retry below.
   */
  async sweepStale(propertyId) {
    const res = await _db.query(
      `UPDATE TALLY.product_matches m
          JOIN TALLY.items i ON m.ITEM_ID = i.ID
          JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
          JOIN TALLY.areas a ON c.AREA_ID = a.ID
          SET m.STATUS = CASE WHEN m.ATTEMPTS + 1 >= ? THEN 'failed' ELSE 'queued' END,
              m.LAST_ERROR = CASE WHEN m.ATTEMPTS + 1 >= ?
                                THEN 'Search stopped responding' ELSE m.LAST_ERROR END,
              m.ATTEMPTS = m.ATTEMPTS + 1
        WHERE a.PROPERTY_ID = ?
          AND m.STATUS = 'searching'
          AND m.SEARCH_STARTED_AT < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
      [_config.match.maxAttempts, _config.match.maxAttempts, propertyId, _config.match.staleMinutes]
    );
    return res.affectedRows;
  },

  /**
   * The worklist. Sweeps first so a row stranded by a dead runner is recovered
   * before it is listed, rather than sitting in 'searching' forever.
   *
   * 'none' and 'failed' are included deliberately: if a failed lookup vanished
   * from the list, nobody would ever learn it failed.
   *
   * This is ALSO the recovery trigger for a 'queued' row: runNow's only other
   * caller is the queue route, on a fresh row, and the sweep above only
   * reaches 'searching' — so without this, a row a failed run set back to
   * 'queued' is never picked up again, ATTEMPTS never climbs, and 'failed' is
   * unreachable. Exactly the print module's lazy-sweep-on-read pattern, one
   * level up: the next person to look at the worklist is what un-sticks it.
   */
  async list(propertyId, userId) {
    await MatchesService.sweepStale(propertyId);
    const rows = await _db.query(
      `SELECT m.ID, m.ITEM_ID, m.STATUS, m.CANDIDATES, m.LAST_ERROR, m.ATTEMPTS, m.CREATED_AT,
              i.NAME AS ITEM_NAME, c.NAME AS CONTAINER_NAME
         FROM TALLY.product_matches m
         JOIN TALLY.items i ON m.ITEM_ID = i.ID
         JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
         JOIN TALLY.areas a ON c.AREA_ID = a.ID
         JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
         JOIN TALLY.property_members pm ON p.ID = pm.PROPERTY_ID
        WHERE pm.USER_ID = ? AND p.ID = ?
          AND i.DELETED_AT IS NULL
          AND c.DELETED_AT IS NULL
          AND a.DELETED_AT IS NULL
          AND p.DELETED_AT IS NULL
          AND m.STATUS IN ('queued','searching','ready','none','failed')
        ORDER BY m.CREATED_AT DESC`,
      [userId, propertyId]
    );

    // Capped at 5 so a big backlog does not fire dozens of concurrent runner
    // calls from one GET, and restricted to rows under the attempts cap so a
    // row already at the limit is left for the sweep to mark 'failed' instead
    // of being retried here forever. Derived from the rows just read — same
    // ownership join, no second query — rather than re-issued, so there is
    // only one privacy-scoped query to keep correct.
    rows
      .filter((r) => r.STATUS === 'queued' && r.ATTEMPTS < _config.match.maxAttempts)
      .slice(0, 5)
      .forEach((r) => { void MatchesService.runNow(r.ID); });

    return rows.map((r) => ({
      id: r.ID,
      itemId: r.ITEM_ID,
      itemName: r.ITEM_NAME,
      containerName: r.CONTAINER_NAME,
      status: r.STATUS,
      candidates: typeof r.CANDIDATES === 'string'
        ? JSON.parse(r.CANDIDATES || '[]') : (r.CANDIDATES || []),
      lastError: r.LAST_ERROR,
      createdAt: r.CREATED_AT,
    }));
  },

  /**
   * Attach a chosen candidate, or dismiss the match.
   *
   * Convergence: products.BARCODE is UNIQUE, so a known UPC links the existing
   * catalog row instead of racing the barcode path to create a second one.
   */
  async resolve(matchId, userId, { candidateIndex, dismiss }) {
    // Same four-level join as queue and items.service.js's getRecent: a soft
    // delete anywhere above the item must hide the match the same way it
    // hides the item, or a caller could resolve a match they cannot reach.
    const rows = await _db.query(
      `SELECT m.ID, m.ITEM_ID, m.STATUS, m.CANDIDATES
         FROM TALLY.product_matches m
         JOIN TALLY.items i ON m.ITEM_ID = i.ID
         JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
         JOIN TALLY.areas a ON c.AREA_ID = a.ID
         JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
         JOIN TALLY.property_members pm ON p.ID = pm.PROPERTY_ID
        WHERE m.ID = ? AND pm.USER_ID = ?
          AND i.DELETED_AT IS NULL
          AND c.DELETED_AT IS NULL
          AND a.DELETED_AT IS NULL
          AND p.DELETED_AT IS NULL`,
      [matchId, userId]
    );
    if (rows.length === 0) {
      const err = new Error('Match not found');
      err.status = 404;
      throw err;
    }
    const match = rows[0];

    // A decision was already made on this match. Resolving it again would
    // silently reassign items.PRODUCT_ID out from under whoever acted on the
    // first decision; dismissing it after that would flip STATUS to
    // 'dismissed' while PRODUCT_ID kept pointing at the resolved product —
    // the two tables would disagree. Same terminal set queue already treats
    // as untouchable.
    if (match.STATUS === 'resolved' || match.STATUS === 'dismissed') {
      const err = new Error(`Match is already ${match.STATUS}`);
      err.status = 409;
      throw err;
    }

    if (dismiss) {
      await _db.query(
        `UPDATE TALLY.product_matches
            SET STATUS = 'dismissed', RESOLVED_AT = NOW() WHERE ID = ?`,
        [matchId]
      );
      return { product: null, duplicates: [] };
    }

    const candidates = typeof match.CANDIDATES === 'string'
      ? JSON.parse(match.CANDIDATES || '[]') : (match.CANDIDATES || []);
    const chosen = candidates[candidateIndex];
    if (!chosen) {
      const err = new Error('No such candidate');
      err.status = 400;
      throw err;
    }

    // Duplicate detection lands HERE, not at capture: this is the first
    // moment a barcode exists to check against. Reuses ProductsService's own
    // checkDuplicate — same membership-scoped join, same {id, name,
    // containerName, areaName, propertyName} shape duplicate-check.tsx
    // renders — rather than keeping a second copy of the query. Run BEFORE
    // this item is linked below: checkDuplicate has no ID-exclusion
    // parameter (the scan flow that owns it calls it before the item being
    // checked even exists), so running it first is what keeps this item from
    // appearing as a "duplicate" of itself. It is a scoped READ with no side
    // effects, so it stays outside the transaction below — there is nothing
    // here that needs to roll back.
    let duplicates = [];
    if (chosen.upc) {
      duplicates = await ProductsService.checkDuplicate(chosen.upc, userId);
    }

    // The catalog write, the item link and the match resolution commit as ONE
    // transaction. They used to be five separate statements: a failure
    // between the items UPDATE and the product_matches UPDATE left the item
    // linked while the match still read 'ready', and retrying (STATUS was
    // never 'resolved', so nothing here refuses a second attempt) re-ran the
    // catalog step too — for a UPC-less candidate that means a SECOND
    // products row, because there is no UNIQUE key to converge on without a
    // barcode. Wrapping the whole write sequence means a failure anywhere
    // rolls all of it back, and a retry starts clean.
    const written = await _db.withTransaction(async (tx) => {
      // Converge on the catalog before inserting. productName/productBrand
      // default to the candidate's own guess, but are overwritten with the
      // stored row's values whenever we link to a product we did not just
      // create — the response must describe the row actually linked, never a
      // candidate that may disagree with a catalog entry another flow wrote.
      let productId = null;
      let productName = chosen.name;
      let productBrand = chosen.brand;
      if (chosen.upc) {
        const existing = await tx.query(
          'SELECT ID, NAME, BRAND FROM TALLY.products WHERE BARCODE = ?', [chosen.upc]
        );
        if (existing.length > 0) {
          productId = existing[0].ID;
          productName = existing[0].NAME;
          productBrand = existing[0].BRAND;
        }
      }

      if (productId == null) {
        try {
          const res = await tx.query(
            `INSERT INTO TALLY.products
               (BARCODE, NAME, BRAND, IMAGE_URL, RETAIL_PRICE, RETAIL_LINKS, DATA_SOURCE)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [chosen.upc, chosen.name, chosen.brand, chosen.imageUrl, chosen.priceUsd,
             JSON.stringify([{ retailer: chosen.sourceDomain, url: chosen.sourceUrl,
                               price: chosen.priceUsd }]),
             'vision_match']
          );
          productId = res.insertId;
        } catch (err) {
          // Nothing holds a lock between the SELECT above and this INSERT, so
          // two concurrent resolves of the same UPC can both miss and both
          // reach here. products.BARCODE is UNIQUE — the loser re-selects and
          // links the winner's row instead of surfacing a raw duplicate-key
          // error, which is exactly the convergence this function exists for.
          // A duplicate-key error does not abort an InnoDB transaction, so
          // this recovery still works from inside one.
          if (err.code !== 'ER_DUP_ENTRY' || !chosen.upc) throw err;
          const winner = await tx.query(
            'SELECT ID, NAME, BRAND FROM TALLY.products WHERE BARCODE = ?', [chosen.upc]
          );
          if (winner.length === 0) throw err;
          productId = winner[0].ID;
          productName = winner[0].NAME;
          productBrand = winner[0].BRAND;
        }
      }

      await tx.query(
        'UPDATE TALLY.items SET PRODUCT_ID = ? WHERE ID = ?', [productId, match.ITEM_ID]
      );
      await tx.query(
        `UPDATE TALLY.product_matches
            SET STATUS = 'resolved', SELECTED_PRODUCT_ID = ?, RESOLVED_AT = NOW()
          WHERE ID = ?`,
        [productId, matchId]
      );

      return { productId, productName, productBrand };
    });

    return {
      product: { id: written.productId, name: written.productName, brand: written.productBrand,
                 barcode: chosen.upc },
      duplicates,
    };
  },
};

module.exports = MatchesService;
