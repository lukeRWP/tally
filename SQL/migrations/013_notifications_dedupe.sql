-- 013: notifications.DUE_ON + DISMISSED_AT, so a due date notifies once (#348).
--
-- checkDateNotifications deduped on "same entity within the last 24 hours", so
-- an item date inside its 30-day window produced a fresh notification every
-- day for a month, and an overdue loan every day until it came back. The right
-- key is the due date itself: one notification per (user, entity, due date).
-- DUE_ON carries it — item_dates.DATE_VALUE for custom_date, DATE(DUE_AT) for
-- lending_due. Editing the date changes the key, so a rescheduled date
-- notifies once more, which is what a user would expect.
--
-- A once-ever key only works if the marker survives dismissal, and dismiss was
-- a hard DELETE — the row that proved "already told you" vanished with the
-- click and the notification came straight back. DISMISSED_AT makes dismiss
-- soft: reads filter it out, the dedupe check still sees it.
--
-- The dedupe key is UNIQUE rather than a plain index. The list handler kicks
-- the check fire-and-forget on every load, so two tabs opening together race
-- SELECT-then-INSERT; the constraint turns the loser into ER_DUP_ENTRY, which
-- the per-row catch treats as "already there". Rows from before this migration
-- have DUE_ON NULL, and MySQL treats NULLs as distinct in unique indexes, so
-- existing data cannot collide with itself.
--
-- Additive only. Idempotent via the 002 information_schema-guard pattern —
-- MySQL 8 has no `ADD COLUMN ... IF NOT EXISTS`, and the migrate-all playbook
-- stops at the first error, so a bare ADD COLUMN re-run would block every later
-- migration behind it.
--
-- No `USE` statement, unqualified table name: the migrate-all playbook selects
-- the app database itself, so TABLE_SCHEMA = DATABASE() is the right guard.

-- DUE_ON
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'notifications'
     AND COLUMN_NAME  = 'DUE_ON'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE notifications ADD COLUMN DUE_ON DATE NULL AFTER ENTITY_ID',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- DISMISSED_AT
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'notifications'
     AND COLUMN_NAME  = 'DISMISSED_AT'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE notifications ADD COLUMN DISMISSED_AT DATETIME NULL AFTER READ_AT',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- one notification per (user, type, entity, due date)
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'notifications'
     AND INDEX_NAME   = 'uq_notifications_due'
);
SET @ddl := IF(@idx_exists = 0,
  'ALTER TABLE notifications ADD UNIQUE KEY uq_notifications_due (USER_ID, TYPE, ENTITY_TYPE, ENTITY_ID, DUE_ON)',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
