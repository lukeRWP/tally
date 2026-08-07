-- Make "delete" actually mean "moved to the recycle bin" for containers and areas.
--
-- THE PROBLEM. Deleting a container cascades a soft-delete through the closure
-- table to its whole subtree; deleting an area does the same by AREA_ID. Both
-- guard with `WHERE DELETED_AT IS NULL`, so they only stamp rows that were LIVE
-- at that moment. That guard is correct — but it means a deleted subtree is a
-- MIX of rows from different delete operations, and DELETED_AT alone cannot say
-- which ones a given restore is allowed to bring back. Restore bin A and you
-- must not resurrect child bin B that the user had deleted a month earlier.
--
-- THE FIX. Every delete opens a batch and stamps the rows it actually touched.
-- Restore then means "un-delete exactly the rows carrying this batch id", which
-- is precise by construction and needs no guesswork about timestamps.
--
-- DELETE_BATCH_ID IS NULL  = live (or deleted before this migration, see below)
-- DELETE_BATCH_ID NOT NULL = in the recycle bin as part of that batch
--
-- Restore clears it back to NULL, so a row cannot be restored twice and a
-- partially-restored batch describes itself honestly.
--
-- SCOPE: areas, containers, items. Deliberately NOT properties. A
-- properties.DELETE_BATCH_ID would form an FK cycle with
-- delete_batches.PROPERTY_ID, which the strictly dependency-ordered base schema
-- cannot express, and it would deadlock a purge in both directions. Property
-- delete already loops AreasService.cascadeDelete, so each area it sweeps gets
-- its own batch and is individually restorable once the property is back.
--
-- IDEMPOTENT. The migrate playbook stops at the first error and blocks every
-- later migration behind it — that is exactly how 002 once blocked 003. MySQL 8
-- has no `ADD COLUMN IF NOT EXISTS`, so each table is guarded by an
-- information_schema check applied through a prepared statement, the same shape
-- as 002_entity_indexes.sql. One guard per table (not per clause) is sound
-- because MySQL 8 rolls a failed multi-clause ALTER back atomically.
--
-- No `USE` statement — the migrate-all playbook selects the app DB (-D TALLY).
--
-- NOT folded into SQL/init/001_TALLY_Init.sql, matching the precedent 003 set
-- for print_jobs: locally, SQL/init/002_apply_migrations.sh applies this on top
-- of the base schema, so a fresh `task db:reset` still lands here.

CREATE TABLE IF NOT EXISTS delete_batches (
    ID          INT                                            NOT NULL AUTO_INCREMENT,
    PROPERTY_ID INT                                            NOT NULL,
    ROOT_TYPE   ENUM('area','container','item')                NOT NULL,
    ROOT_ID     INT                                            NOT NULL,
    -- Denormalised so the bin can name what was deleted without joining to a
    -- row that a later purge may have destroyed.
    ROOT_NAME   VARCHAR(255)                                   NOT NULL,
    -- Nullable only so the backfill below can admit it does not know the actor.
    DELETED_BY  INT                                            NULL,
    DELETED_AT  DATETIME                                       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ID),
    KEY idx_delete_batches_property (PROPERTY_ID, DELETED_AT),
    -- The bin's list query and the backfill's NOT EXISTS both seek by root.
    KEY idx_delete_batches_root (ROOT_TYPE, ROOT_ID),
    CONSTRAINT fk_delete_batches_property FOREIGN KEY (PROPERTY_ID) REFERENCES properties (ID),
    CONSTRAINT fk_delete_batches_user     FOREIGN KEY (DELETED_BY)  REFERENCES users (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- areas
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME   = 'areas'
                AND COLUMN_NAME  = 'DELETE_BATCH_ID');
SET @ddl := IF(@col = 0,
  'ALTER TABLE areas
     ADD COLUMN DELETE_BATCH_ID INT NULL,
     ADD KEY idx_areas_delete_batch (DELETE_BATCH_ID),
     ADD CONSTRAINT fk_areas_delete_batch FOREIGN KEY (DELETE_BATCH_ID) REFERENCES delete_batches (ID)',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- containers
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME   = 'containers'
                AND COLUMN_NAME  = 'DELETE_BATCH_ID');
SET @ddl := IF(@col = 0,
  'ALTER TABLE containers
     ADD COLUMN DELETE_BATCH_ID INT NULL,
     ADD KEY idx_containers_delete_batch (DELETE_BATCH_ID),
     ADD CONSTRAINT fk_containers_delete_batch FOREIGN KEY (DELETE_BATCH_ID) REFERENCES delete_batches (ID)',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- items
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME   = 'items'
                AND COLUMN_NAME  = 'DELETE_BATCH_ID');
SET @ddl := IF(@col = 0,
  'ALTER TABLE items
     ADD COLUMN DELETE_BATCH_ID INT NULL,
     ADD KEY idx_items_delete_batch (DELETE_BATCH_ID),
     ADD CONSTRAINT fk_items_delete_batch FOREIGN KEY (DELETE_BATCH_ID) REFERENCES delete_batches (ID)',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- Backfill: adopt everything already in the recycle bin as a SINGLETON batch
-- rooted at itself.
--
-- Their true grouping is unrecoverable — that is precisely the bug this
-- migration fixes — and a singleton is the strongest honest claim the existing
-- data supports. Without this, rows deleted before today would vanish from a
-- batch-driven bin instead of remaining restorable.
--
-- Each INSERT is guarded by NOT EXISTS on (ROOT_TYPE, ROOT_ID) rather than by
-- the paired UPDATE's effect. The INSERT and the UPDATE are separate
-- autocommitted statements, so a run interrupted between them would otherwise
-- re-INSERT on the next attempt and leave duplicate headers with zero members —
-- permanent phantom bin rows that name something and restore nothing.
-- ---------------------------------------------------------------------------

-- areas
INSERT INTO delete_batches (PROPERTY_ID, ROOT_TYPE, ROOT_ID, ROOT_NAME, DELETED_BY, DELETED_AT)
SELECT a.PROPERTY_ID, 'area', a.ID, a.NAME, NULL, a.DELETED_AT
  FROM areas a
 WHERE a.DELETED_AT IS NOT NULL
   AND a.DELETE_BATCH_ID IS NULL
   AND NOT EXISTS (SELECT 1 FROM delete_batches b
                    WHERE b.ROOT_TYPE = 'area' AND b.ROOT_ID = a.ID);

UPDATE areas a
  JOIN delete_batches b ON b.ROOT_TYPE = 'area' AND b.ROOT_ID = a.ID
   SET a.DELETE_BATCH_ID = b.ID
 WHERE a.DELETED_AT IS NOT NULL AND a.DELETE_BATCH_ID IS NULL;

-- containers
INSERT INTO delete_batches (PROPERTY_ID, ROOT_TYPE, ROOT_ID, ROOT_NAME, DELETED_BY, DELETED_AT)
SELECT ar.PROPERTY_ID, 'container', c.ID, c.NAME, NULL, c.DELETED_AT
  FROM containers c
  JOIN areas ar ON c.AREA_ID = ar.ID
 WHERE c.DELETED_AT IS NOT NULL
   AND c.DELETE_BATCH_ID IS NULL
   AND NOT EXISTS (SELECT 1 FROM delete_batches b
                    WHERE b.ROOT_TYPE = 'container' AND b.ROOT_ID = c.ID);

UPDATE containers c
  JOIN delete_batches b ON b.ROOT_TYPE = 'container' AND b.ROOT_ID = c.ID
   SET c.DELETE_BATCH_ID = b.ID
 WHERE c.DELETED_AT IS NOT NULL AND c.DELETE_BATCH_ID IS NULL;

-- items
INSERT INTO delete_batches (PROPERTY_ID, ROOT_TYPE, ROOT_ID, ROOT_NAME, DELETED_BY, DELETED_AT)
SELECT ar.PROPERTY_ID, 'item', i.ID, i.NAME, NULL, i.DELETED_AT
  FROM items i
  JOIN containers c ON i.CONTAINER_ID = c.ID
  JOIN areas ar ON c.AREA_ID = ar.ID
 WHERE i.DELETED_AT IS NOT NULL
   AND i.DELETE_BATCH_ID IS NULL
   AND NOT EXISTS (SELECT 1 FROM delete_batches b
                    WHERE b.ROOT_TYPE = 'item' AND b.ROOT_ID = i.ID);

UPDATE items i
  JOIN delete_batches b ON b.ROOT_TYPE = 'item' AND b.ROOT_ID = i.ID
   SET i.DELETE_BATCH_ID = b.ID
 WHERE i.DELETED_AT IS NOT NULL AND i.DELETE_BATCH_ID IS NULL;
