-- 015: PW IAM step 4 — tally signs in through pwiam (@pw/auth-express).
--
-- users.SUB is the pwiam subject (a 26-char ULID) and becomes the login key;
-- ENTRA_ID stays for the one-time backfill (a returning user is matched on the
-- token's entra_oid and gets SUB written) but a user created through pwiam
-- has no Entra object id, so it must allow NULL.
--
-- sessions gains the three columns the shim's mysqlSession adapter reads and
-- writes beside TOKEN/USER_ID/EXPIRES_AT: SUB and SID (back-channel logout by
-- user / by pwiam session) and IAM_STATE (the sealed refresh/access/ID tokens
-- + user snapshot). The old ID/CREATED_AT columns keep their defaults, so the
-- adapter's six-column INSERT still succeeds.
--
-- Idempotent by construction: SQL/ci/migration-gate.sh applies the whole chain
-- twice and requires both passes to succeed, because migrate-all stops at the
-- first error and would strand every later migration behind it.

-- users.SUB -------------------------------------------------------------------
SET @has_sub := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'SUB'
);
SET @ddl := IF(@has_sub = 0,
  'ALTER TABLE `users` ADD COLUMN `SUB` varchar(26) DEFAULT NULL AFTER `ENTRA_ID`',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_uq_sub := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'uq_users_sub'
);
SET @ddl := IF(@has_uq_sub = 0,
  'ALTER TABLE `users` ADD UNIQUE KEY `uq_users_sub` (`SUB`)',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- users.ENTRA_ID nullable ------------------------------------------------------
SET @entra_nullable := (
  SELECT IS_NULLABLE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'ENTRA_ID'
);
SET @ddl := IF(@entra_nullable = 'NO',
  'ALTER TABLE `users` MODIFY COLUMN `ENTRA_ID` varchar(255) DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- sessions.SUB / SID / IAM_STATE ---------------------------------------------
SET @has_s_sub := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions' AND COLUMN_NAME = 'SUB'
);
SET @ddl := IF(@has_s_sub = 0,
  'ALTER TABLE `sessions` ADD COLUMN `SUB` varchar(64) DEFAULT NULL AFTER `EXPIRES_AT`',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_s_sid := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions' AND COLUMN_NAME = 'SID'
);
SET @ddl := IF(@has_s_sid = 0,
  'ALTER TABLE `sessions` ADD COLUMN `SID` varchar(64) DEFAULT NULL AFTER `SUB`',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_s_state := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions' AND COLUMN_NAME = 'IAM_STATE'
);
SET @ddl := IF(@has_s_state = 0,
  'ALTER TABLE `sessions` ADD COLUMN `IAM_STATE` text AFTER `SID`',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_idx_sid := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions' AND INDEX_NAME = 'idx_sessions_sid'
);
SET @ddl := IF(@has_idx_sid = 0,
  'ALTER TABLE `sessions` ADD KEY `idx_sessions_sid` (`SID`)',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_idx_sub := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions' AND INDEX_NAME = 'idx_sessions_sub'
);
SET @ddl := IF(@has_idx_sub = 0,
  'ALTER TABLE `sessions` ADD KEY `idx_sessions_sub` (`SUB`)',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
