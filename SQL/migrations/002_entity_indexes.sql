-- Indexes for entity-scoped lookups that currently full-scan.
--
-- change_log: the only index led with (PROPERTY_ID, CREATED_AT), so the
-- entity-history endpoint (GET /api/audit/_x_/entity/:type/:id) full-scanned
-- the fastest-growing table. change_log is append-only, so an added key is cheap.
--
-- entity_tags: the only index is UNIQUE (TAG_ID, ENTITY_TYPE, ENTITY_ID) — its
-- leading column is TAG_ID, so a lookup BY an entity (getForEntity, the
-- tag-filtered item search join) could not seek and scanned the table.
--
-- IDEMPOTENT BY NECESSITY. Both indexes were later folded into
-- SQL/init/001_TALLY_Init.sql (lines 266 and 285), so any database created from
-- the current base schema already has them and a bare ADD KEY dies with
-- "ERROR 1061 Duplicate key name". Not hypothetical: that is exactly how this
-- failed against prod on 2026-08-05, and because the migrate playbook stops on
-- the first error it blocked 003 behind it.
--
-- MySQL 8 has no `ADD KEY ... IF NOT EXISTS`, so each index is guarded by an
-- information_schema check and applied via a prepared statement. Re-running
-- against a database that already has them is a no-op.
--
-- No `USE` statement — the migrate-all playbook selects the app DB (-D TALLY).

-- change_log
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'change_log'
     AND INDEX_NAME   = 'idx_change_log_entity'
);
SET @ddl := IF(@idx_exists = 0,
  'ALTER TABLE change_log ADD KEY idx_change_log_entity (ENTITY_TYPE, ENTITY_ID, CREATED_AT)',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- entity_tags
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'entity_tags'
     AND INDEX_NAME   = 'idx_entity_tags_entity'
);
SET @ddl := IF(@idx_exists = 0,
  'ALTER TABLE entity_tags ADD KEY idx_entity_tags_entity (ENTITY_TYPE, ENTITY_ID)',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
