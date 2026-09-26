-- 016: the Pi print agent moves onto pwiam service-account API keys, dual
-- accept alongside the legacy tp_ bearer token (PW service-accounts plan
-- phase 2; tally #388).
--
-- printer_agents.SERVICE_ACCOUNT_ID holds the pwiam service-account id (a
-- 26-char ULID — same shape as users.SUB, migration 015) that a `pwk_...`
-- API key introspects to. It sits next to TOKEN_HASH because the two columns
-- are the two things an agent row can authenticate BY: a row may carry
-- either, and — during the dual-accept window — both at once. Its unique key
-- means one service account can be bound to at most one printer.
--
-- TOKEN_HASH becomes nullable: a printer bound straight to a service account
-- (POST /agents with serviceAccountId, or the PUT .../service-account binding
-- route) never has a tp_ token minted for it, so the column has nothing to
-- hold. Its own unique key is untouched — MySQL/InnoDB does not enforce
-- uniqueness between NULLs, so any number of SA-only rows can sit alongside
-- it with TOKEN_HASH NULL.
--
-- Idempotent via the 002 information_schema-guard pattern (MySQL 8 has no
-- `ADD COLUMN ... IF NOT EXISTS` / `MODIFY COLUMN ... IF NOT EXISTS`). No
-- `USE` statement — the migrate-all playbook selects the app database.

-- printer_agents.SERVICE_ACCOUNT_ID -------------------------------------------
SET @has_sa_id := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'printer_agents' AND COLUMN_NAME = 'SERVICE_ACCOUNT_ID'
);
SET @ddl := IF(@has_sa_id = 0,
  'ALTER TABLE `printer_agents` ADD COLUMN `SERVICE_ACCOUNT_ID` char(26) DEFAULT NULL AFTER `TOKEN_HASH`',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_uq_sa := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'printer_agents' AND INDEX_NAME = 'uq_printer_agents_service_account'
);
SET @ddl := IF(@has_uq_sa = 0,
  'ALTER TABLE `printer_agents` ADD UNIQUE KEY `uq_printer_agents_service_account` (`SERVICE_ACCOUNT_ID`)',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- printer_agents.TOKEN_HASH becomes nullable -----------------------------------
SET @token_hash_nullable := (
  SELECT IS_NULLABLE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'printer_agents' AND COLUMN_NAME = 'TOKEN_HASH'
);
SET @ddl := IF(@token_hash_nullable = 'NO',
  'ALTER TABLE `printer_agents` MODIFY COLUMN `TOKEN_HASH` char(64) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
