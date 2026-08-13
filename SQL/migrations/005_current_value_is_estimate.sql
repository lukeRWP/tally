-- Mark a CURRENT_VALUE that was guessed rather than declared.
--
-- items.CURRENT_VALUE is read straight into the insurance summary, and it is
-- also where the vision flow writes the model's ESTIMATED value when the user
-- presses Keep. Those are different kinds of number — one the user asserts, one
-- a photo suggested — and an insurance document is the single worst place for
-- them to look identical. The column carries no provenance, so the report had
-- no way to tell them apart and printed both as plain currency.
--
-- A boolean rather than dropping the estimate: the guess is worth keeping (it
-- beats a blank on a claim form), it just has to be labelled as one.
--
-- BACKFILL LIMITATION, stated rather than guessed at: rows written before this
-- migration default to 0 = declared. Any value the AI wrote between vision
-- shipping (2026-08-12) and this migration is indistinguishable after the fact,
-- so it will read as declared. There is no signal in the data to recover it.
--
-- MySQL 8 has no `ADD COLUMN ... IF NOT EXISTS`, and the migrate playbook stops
-- at the first error — a bare ALTER that hits an already-migrated database dies
-- with ERROR 1060 and blocks every migration behind it (exactly how 002 broke
-- prod on 2026-08-05). Guarded by information_schema + a prepared statement, so
-- re-running is a no-op.
--
-- No `USE` statement — the migrate-all playbook selects the app DB (-D TALLY).

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'items'
     AND COLUMN_NAME  = 'CURRENT_VALUE_IS_ESTIMATE'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE items ADD COLUMN CURRENT_VALUE_IS_ESTIMATE TINYINT(1) NOT NULL DEFAULT 0 AFTER CURRENT_VALUE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
