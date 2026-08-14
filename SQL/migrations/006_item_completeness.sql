-- What is actually in the bin: the thing, or only its packaging/spares.
--
-- Scanning a retail box files an item under the product's name and, via the
-- catalogue or photo identification, its full price — so an empty computer box
-- can land in the inventory carrying the computer's value while the computer
-- itself is in use somewhere else. That is the same failure the value-provenance
-- work (005) addressed from the other direction: a number that is not wrong so
-- much as not what it appears to be.
--
-- Deliberately an enum on items rather than a link to a parent item. The thing
-- the box belongs to often is not inventoried at all — it is in use, not in a
-- container — so a foreign key would have nothing to point at, and the physical
-- act being recorded is one scan of one object.
--
-- 'complete' is the default and carries no badge: the overwhelming majority of
-- items are whole, and marking the norm would bury the exceptions.
--
-- Guarded by information_schema + a prepared statement. MySQL 8 has no
-- `ADD COLUMN ... IF NOT EXISTS`, and the migrate playbook stops at the first
-- error, so a bare ALTER against an already-migrated database dies with
-- ERROR 1060 and blocks everything behind it.
--
-- No `USE` statement — the migrate-all playbook selects the app DB (-D TALLY).

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'items'
     AND COLUMN_NAME  = 'COMPLETENESS'
);
SET @ddl := IF(@col_exists = 0,
  "ALTER TABLE items ADD COLUMN COMPLETENESS ENUM('complete','box_only','accessories_only') NOT NULL DEFAULT 'complete' AFTER `CONDITION`",
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
