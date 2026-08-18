-- Photo → product match: the worklist behind deferred product selection.
--
-- A match row is created when the capture flow queues one, worked by a
-- fire-and-forget runner, and resolved later from /matches.
--
-- IDEMPOTENT. The migrate-all playbook stops at the first error, so a
-- non-idempotent statement here blocks every later migration behind it (that
-- is exactly how 002 blocked 003 on 2026-08-05).
--
-- No `USE` statement — the playbook selects the app DB with -D TALLY, which is
-- also why table names below are unqualified and the guard reads DATABASE().

CREATE TABLE IF NOT EXISTS product_matches (
    ID                   INT           NOT NULL AUTO_INCREMENT,
    ITEM_ID              INT           NOT NULL,
    CREATED_BY           INT           NOT NULL,
    STATUS               ENUM('queued','searching','ready','none','failed','resolved','dismissed')
                                       NOT NULL DEFAULT 'queued',
    SEARCH_QUERY         JSON          NULL,
    CANDIDATES           JSON          NULL,
    SELECTED_PRODUCT_ID  INT           NULL,
    ATTEMPTS             INT           NOT NULL DEFAULT 0,
    -- Paid searches actually fired for this row, distinct from ATTEMPTS: a
    -- cap-refused run in runNow() does not search, so it must not count here.
    -- The daily cost cap sums THIS column, not COUNT(*) of rows — a re-queue
    -- upserts the same row (no new row) but still fires another paid search,
    -- and rows-created was blind to that spend.
    SEARCH_COUNT         INT           NOT NULL DEFAULT 0,
    LAST_ERROR           VARCHAR(500)  NULL,
    SEARCH_STARTED_AT    DATETIME      NULL,
    CREATED_AT           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UPDATED_AT           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    RESOLVED_AT          DATETIME      NULL,
    PRIMARY KEY (ID),
    -- One match per item: a double-fired queue call cannot create two.
    UNIQUE KEY uq_product_matches_item (ITEM_ID),
    KEY ix_product_matches_status (STATUS),
    -- Serves the per-user daily cap count (countToday, in matches.service.js)
    -- on CREATED_BY + UPDATED_AT — the column set that query actually filters
    -- on, and it runs on every queue() call and every runNow() attempt.
    -- Keyed on UPDATED_AT, not CREATED_AT: a search fired long after a row
    -- was first created (a re-queue) still has to land in today's count, and
    -- UPDATED_AT is the column a search attempt actually touches.
    KEY ix_product_matches_creator (CREATED_BY, UPDATED_AT),
    -- Items are soft-deleted normally, but the recycle bin's 30-day purge is a
    -- hard DELETE, and a match must not outlive its item.
    CONSTRAINT fk_product_matches_item
        FOREIGN KEY (ITEM_ID) REFERENCES items (ID) ON DELETE CASCADE,
    CONSTRAINT fk_product_matches_product
        FOREIGN KEY (SELECTED_PRODUCT_ID) REFERENCES products (ID),
    CONSTRAINT fk_product_matches_user
        FOREIGN KEY (CREATED_BY) REFERENCES users (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- SEARCH_COUNT was added to the CREATE TABLE above after this file's first
-- version shipped. CREATE TABLE IF NOT EXISTS is a no-op against a database
-- that already ran the earlier copy, so on THAT database the column would
-- silently never exist and every SEARCH_COUNT query would 500 — the same
-- class of mistake rule 16 exists to prevent. MySQL 8 has no
-- "ADD COLUMN IF NOT EXISTS", so guard it the same way DATA_SOURCE is guarded
-- below: check information_schema first, ALTER only if it is actually
-- missing. A fresh install already has the column from the CREATE TABLE
-- above, so this is a no-op there.
SET @has_search_count := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'product_matches'
     AND COLUMN_NAME  = 'SEARCH_COUNT'
);
SET @ddl := IF(@has_search_count = 0,
  'ALTER TABLE product_matches ADD COLUMN SEARCH_COUNT INT NOT NULL DEFAULT 0 AFTER ATTEMPTS',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- products.DATA_SOURCE gains 'vision_match'. MySQL 8 has no
-- "ADD VALUE IF NOT EXISTS", so read the current type and only ALTER when the
-- value is absent. COALESCE makes a missing column a no-op rather than a crash.
SET @col := (
  SELECT COLUMN_TYPE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'products'
     AND COLUMN_NAME  = 'DATA_SOURCE'
);
SET @ddl := IF(LOCATE('vision_match', COALESCE(@col, 'vision_match')) = 0,
  "ALTER TABLE products MODIFY COLUMN DATA_SOURCE ENUM('upc_db','open_food_facts','scrape','manual','vision_match') NULL",
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
