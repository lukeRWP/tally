-- #122: tether printer-agent bearer tokens to the user who minted them.
--
-- printer_agents stored no record of WHO created an agent, so requireAgent
-- validated TOKEN_HASH alone — a token outlived the minting user's membership
-- (and role). CREATED_BY lets validation join the minting user's LIVE
-- property_members row, so revoking the member (or demoting them below the
-- minting requirement) kills every token they minted.
--
-- Existing rows are backfilled to the property's owner: they were minted from
-- the Settings page of a single-owner deployment before any role gate existed,
-- and agent registration is now owner-only, so the owner is the only tether
-- under which a legacy token should keep working. MIN(USER_ID) makes the pick
-- deterministic if a property ever has two owners (any owner satisfies the
-- validation join, so which one is recorded does not change behaviour).
--
-- IDEMPOTENT: MySQL 8 has no ADD COLUMN/CONSTRAINT ... IF NOT EXISTS, so both
-- DDL statements are guarded by information_schema checks and applied via
-- prepared statements (the 002 pattern). The backfill is naturally re-runnable
-- (WHERE CREATED_BY IS NULL).
--
-- No `USE` statement — the migrate-all playbook selects the app DB (-D TALLY).

-- 1. the column
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'printer_agents'
     AND COLUMN_NAME  = 'CREATED_BY'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE printer_agents ADD COLUMN CREATED_BY INT NULL AFTER TOKEN_HASH',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. backfill legacy agents to their property's owner
UPDATE printer_agents a
  JOIN (SELECT PROPERTY_ID, MIN(USER_ID) AS USER_ID
          FROM property_members
         WHERE ROLE = 'owner'
         GROUP BY PROPERTY_ID) o ON o.PROPERTY_ID = a.PROPERTY_ID
   SET a.CREATED_BY = o.USER_ID
 WHERE a.CREATED_BY IS NULL;

-- 3. the FK (parity with print_jobs.CREATED_BY)
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND TABLE_NAME        = 'printer_agents'
     AND CONSTRAINT_NAME   = 'fk_printer_agents_creator'
);
SET @ddl := IF(@fk_exists = 0,
  'ALTER TABLE printer_agents ADD CONSTRAINT fk_printer_agents_creator FOREIGN KEY (CREATED_BY) REFERENCES users (ID)',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
