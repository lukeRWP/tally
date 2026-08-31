-- 012: per-user daily vision usage, so the spend cap survives a restart (#340).
--
-- `products.routes.js` caps photo identification with two express-rate-limit
-- limiters and says why: "A per-minute cap bounds a runaway loop; only a long
-- window bounds a bill." The long window did not bound anything, because
-- express-rate-limit's default store is in memory and every deploy resets it.
-- On 2026-08-30 there were roughly twelve deploys, so a "250 per day" cap was
-- in practice "250 per container lifetime".
--
-- One row per user per UTC day. DAY is a DATE, not a window start, so the
-- reset boundary is a calendar day rather than "24h since your first call" —
-- that is what the setting already claims to mean, and it makes the row
-- trivially readable when someone asks why they were capped.
--
-- The burst limiter deliberately stays in memory: a 60-second window rarely
-- spans a restart, and it guards against a runaway client loop, which is a
-- different job it still does correctly.
--
-- Additive only, and idempotent via CREATE TABLE IF NOT EXISTS (rule 9 —
-- migrate-all stops at the first error, so a re-run must be a no-op). No
-- `USE`: the playbook selects the app database itself.

CREATE TABLE IF NOT EXISTS vision_usage (
  USER_ID     INT       NOT NULL,
  DAY         DATE      NOT NULL,
  CALL_COUNT  INT       NOT NULL DEFAULT 0,
  UPDATED_AT  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (USER_ID, DAY)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
