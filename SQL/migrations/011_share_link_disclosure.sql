-- 011: per-link disclosure choices on share_links (#298).
--
-- A share link is the only no-auth surface in tally, and until now WHAT it
-- publishes was a global rule baked into sharing.service.js — the sharer had no
-- say and no warning. This column is where the per-link choice lives: a JSON
-- object of category -> boolean, e.g. {"address":false,"purchasePrice":true}.
--
-- NULL means "everything the payload can carry", which is exactly the behaviour
-- of every link created before this column existed. Nothing about an existing
-- link changes when this is applied: the server treats NULL and an all-true
-- object identically. A missing key inside the object is likewise "on", so a
-- link created before a new category exists keeps its old disclosure.
--
-- Additive only. Idempotent via the 002 information_schema-guard pattern —
-- MySQL 8 has no `ADD COLUMN ... IF NOT EXISTS`, and the migrate-all playbook
-- stops at the first error, so a bare ADD COLUMN re-run would block every later
-- migration behind it.
--
-- No `USE` statement, unqualified table name: the migrate-all playbook selects
-- the app database itself, so TABLE_SCHEMA = DATABASE() is the right guard.

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'share_links'
     AND COLUMN_NAME  = 'DISCLOSURE'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE share_links ADD COLUMN DISCLOSURE JSON NULL AFTER EXPIRES_AT',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
