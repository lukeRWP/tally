/**
 * The daily photo-identification cap, counted in the database (#340).
 *
 * It used to be an `express-rate-limit` limiter with a 24h window. The route's
 * own comment stated the purpose — "A per-minute cap bounds a runaway loop;
 * only a long window bounds a bill" — and the long window did not deliver it:
 * express-rate-limit's default store is in memory, so every deploy reset the
 * counter. On 2026-08-30 there were roughly twelve deploys, which made a
 * "250 per day" cap mean "250 per container lifetime".
 *
 * The burst limiter stays in memory on purpose. A 60-second window rarely
 * spans a restart, and it guards a runaway client loop rather than the bill.
 *
 * FAIL-OPEN, deliberately. If the counter cannot be read or written, the
 * request is allowed. A spend guard that breaks the feature when the database
 * hiccups is a worse failure than one that occasionally lets a call through:
 * the burst limiter still bounds the damage per minute, and the failure is
 * logged at error so it is visible rather than silent. This is the opposite of
 * the auth path's fail-closed rule, and it is a considered difference — this
 * gate protects a bill, not data.
 *
 * Counted per calendar UTC day rather than a rolling 24h window, because that
 * is what `VISION_DAILY_PER_USER` already implies and it makes the stored row
 * answer "why was I capped?" directly.
 */

/** UTC calendar day as YYYY-MM-DD — the DATE the row is keyed on. */
function utcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * @param {object} deps
 * @param {{query: Function}} deps.db
 * @param {{error?: Function, warn?: Function}} [deps.logger]
 * @param {number} deps.max            calls allowed per user per UTC day
 * @param {() => number} [deps.clock]  injectable for tests
 */
function makeVisionDailyLimit({ db, logger, max, clock = Date.now }) {
  return async function visionDailyLimit(req, res, next) {
    // Anonymous cannot reach here (requireAuth runs first). If it somehow does,
    // there is no user to count against — let the burst limiter handle it.
    const userId = req.user?.id;
    if (!userId) return next();

    const day = utcDay(clock());
    try {
      const rows = await db.query(
        'SELECT CALL_COUNT FROM TALLY.vision_usage WHERE USER_ID = ? AND DAY = ?',
        [userId, day]
      );
      const used = rows[0]?.CALL_COUNT ?? 0;

      if (used >= max) {
        // Same shape the express-rate-limit version returned, so the client's
        // existing `res.status === 429` branch keeps working unchanged.
        return res.status(429).json({
          success: false,
          message: `Daily photo identification limit reached (${max} per day). It resets at midnight UTC.`,
        });
      }

      // Counted on the way IN, at the same point the old limiter sat, so a
      // request that is later rejected for a bad image still costs an
      // attempt — unchanged from the previous behaviour, and the conservative
      // direction for something guarding spend.
      await db.query(
        `INSERT INTO TALLY.vision_usage (USER_ID, DAY, CALL_COUNT) VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE CALL_COUNT = CALL_COUNT + 1`,
        [userId, day]
      );
      return next();
    } catch (err) {
      logger?.error?.('Vision daily limit unavailable — allowing the request', {
        userId, day, error: err?.message,
      });
      return next();
    }
  };
}

module.exports = { makeVisionDailyLimit, utcDay };
