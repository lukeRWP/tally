-- 010: the two missing hot-path indexes from #60 (idx_entity_tags_entity
-- already shipped in 002). Additive only; idempotent via the 002 pattern.
-- items list/search filter constantly on (CONTAINER_ID, STATUS, DELETED_AT),
-- and the recycle sweep scans DELETED_AT.

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'items'
    AND INDEX_NAME   = 'idx_items_container_status'
);
SET @ddl := IF(@idx_exists = 0,
  'ALTER TABLE items ADD KEY idx_items_container_status (CONTAINER_ID, STATUS, DELETED_AT)',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'items'
    AND INDEX_NAME   = 'idx_items_deleted_at'
);
SET @ddl := IF(@idx_exists = 0,
  'ALTER TABLE items ADD KEY idx_items_deleted_at (DELETED_AT)',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
