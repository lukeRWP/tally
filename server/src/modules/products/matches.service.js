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
};

module.exports = MatchesService;
