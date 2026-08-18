const productMatch = require('./lookup/product-match');

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
  },

  async countToday(userId) {
    const rows = await _db.query(
      `SELECT COUNT(*) AS N FROM TALLY.product_matches
        WHERE CREATED_BY = ? AND CREATED_AT > DATE_SUB(NOW(), INTERVAL 1 DAY)`,
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
    try {
      const rows = await _db.query(
        `SELECT ID, SEARCH_QUERY FROM TALLY.product_matches WHERE ID = ?`, [matchId]
      );
      if (rows.length === 0) return;
      const input = typeof rows[0].SEARCH_QUERY === 'string'
        ? JSON.parse(rows[0].SEARCH_QUERY || '{}')
        : (rows[0].SEARCH_QUERY || {});

      await _db.query(
        `UPDATE TALLY.product_matches
            SET STATUS = 'searching', SEARCH_STARTED_AT = NOW()
          WHERE ID = ?`,
        [matchId]
      );

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
        // Back to 'queued' so the sweep retries, unless the cap is reached —
        // one statement so the decision cannot drift from the sweep's.
        await _db.query(
          `UPDATE TALLY.product_matches
              SET STATUS = CASE WHEN ATTEMPTS + 1 >= ? THEN 'failed' ELSE 'queued' END,
                  ATTEMPTS = ATTEMPTS + 1,
                  LAST_ERROR = ?
            WHERE ID = ?`,
          [_config.match.maxAttempts, String(err.message).slice(0, 500), matchId]
        );
      } catch (inner) {
        _logger?.error('could not record match failure', { matchId, error: inner.message });
      }
    }
  },

  /**
   * Lazy sweep, borrowed wholesale from print's sweepStaleClaims: a runner that
   * dies mid-search would otherwise strand its row in 'searching' forever, and
   * this app has nowhere to run a cron.
   */
  async sweepStale() {
    const res = await _db.query(
      `UPDATE TALLY.product_matches
          SET STATUS = CASE WHEN ATTEMPTS + 1 >= ? THEN 'failed' ELSE 'queued' END,
              LAST_ERROR = CASE WHEN ATTEMPTS + 1 >= ?
                                THEN 'Search stopped responding' ELSE LAST_ERROR END,
              ATTEMPTS = ATTEMPTS + 1
        WHERE STATUS = 'searching'
          AND SEARCH_STARTED_AT < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
      [_config.match.maxAttempts, _config.match.maxAttempts, _config.match.staleMinutes]
    );
    return res.affectedRows;
  },

  /**
   * The worklist. Sweeps first so a row stranded by a dead runner is recovered
   * before it is listed, rather than sitting in 'searching' forever.
   *
   * 'none' and 'failed' are included deliberately: if a failed lookup vanished
   * from the list, nobody would ever learn it failed.
   */
  async list(propertyId, userId) {
    await MatchesService.sweepStale();
    const rows = await _db.query(
      `SELECT m.ID, m.ITEM_ID, m.STATUS, m.CANDIDATES, m.LAST_ERROR, m.CREATED_AT,
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

    // Converge on the catalog before inserting.
    let productId = null;
    if (chosen.upc) {
      const existing = await _db.query(
        'SELECT ID FROM TALLY.products WHERE BARCODE = ?', [chosen.upc]
      );
      if (existing.length > 0) productId = existing[0].ID;
    }

    if (productId == null) {
      const res = await _db.query(
        `INSERT INTO TALLY.products
           (BARCODE, NAME, BRAND, IMAGE_URL, RETAIL_PRICE, RETAIL_LINKS, DATA_SOURCE)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [chosen.upc, chosen.name, chosen.brand, chosen.imageUrl, chosen.priceUsd,
         JSON.stringify([{ url: chosen.sourceUrl, domain: chosen.sourceDomain }]),
         'vision_match']
      );
      productId = res.insertId;
    }

    await _db.query(
      'UPDATE TALLY.items SET PRODUCT_ID = ? WHERE ID = ?', [productId, match.ITEM_ID]
    );
    await _db.query(
      `UPDATE TALLY.product_matches
          SET STATUS = 'resolved', SELECTED_PRODUCT_ID = ?, RESOLVED_AT = NOW()
        WHERE ID = ?`,
      [productId, matchId]
    );

    // Duplicate detection lands HERE, not at capture: this is the first moment
    // a barcode exists to check against. Same four-level join, so a duplicate
    // hiding behind a soft-deleted container/area/property is not reported.
    let duplicates = [];
    if (chosen.upc) {
      const dupes = await _db.query(
        `SELECT i.ID, i.NAME, c.NAME AS CONTAINER_NAME
           FROM TALLY.items i
           JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
           JOIN TALLY.areas a ON c.AREA_ID = a.ID
           JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
           JOIN TALLY.property_members pm ON p.ID = pm.PROPERTY_ID
          WHERE i.PRODUCT_ID = ? AND pm.USER_ID = ?
            AND i.ID <> ? AND i.DELETED_AT IS NULL
            AND c.DELETED_AT IS NULL AND a.DELETED_AT IS NULL AND p.DELETED_AT IS NULL`,
        [productId, userId, match.ITEM_ID]
      );
      duplicates = dupes.map((d) => ({
        id: d.ID, name: d.NAME, containerName: d.CONTAINER_NAME,
      }));
    }

    return {
      product: { id: productId, name: chosen.name, brand: chosen.brand, barcode: chosen.upc },
      duplicates,
    };
  },
};

module.exports = MatchesService;
