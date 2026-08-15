-- A small derivative for list rows.
--
-- The capture flow downscales an upload to 1600px, and item-card.tsx renders
-- that into a 32x32 box. A forty-item list therefore pulls down tens of
-- megabytes to draw forty postage stamps. #180 made those bytes cacheable;
-- this is what stops them being fetched in the first place.
--
-- NULL means "no thumbnail yet", which is also the state every existing photo
-- starts in. The read path treats NULL as "serve the original this time and
-- generate one in the background", so the fix rolls itself out as the app is
-- used — no backfill script, no operator step.
--
-- The key is stored rather than derived so the read path never has to ask
-- object storage whether a derivative exists. One HeadObject per row would put
-- a network round trip in the middle of every list render, which is the cost
-- this migration exists to remove.
--
-- Guarded by information_schema + a prepared statement: MySQL 8 has no
-- `ADD COLUMN ... IF NOT EXISTS`, and the migrate playbook stops at the first
-- error, so a bare ALTER against an already-migrated database dies with
-- ERROR 1060 and blocks everything behind it.
--
-- No `USE` statement — the migrate-all playbook selects the app DB (-D TALLY).

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'item_files'
     AND COLUMN_NAME  = 'THUMB_KEY'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE item_files ADD COLUMN THUMB_KEY VARCHAR(255) NULL AFTER FILE_KEY',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
