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
    LAST_ERROR           VARCHAR(500)  NULL,
    SEARCH_STARTED_AT    DATETIME      NULL,
    CREATED_AT           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UPDATED_AT           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    RESOLVED_AT          DATETIME      NULL,
    PRIMARY KEY (ID),
    -- One match per item: a double-fired queue call cannot create two.
    UNIQUE KEY uq_product_matches_item (ITEM_ID),
    KEY ix_product_matches_status (STATUS),
    -- Serves the per-user daily cap count.
    KEY ix_product_matches_creator (CREATED_BY, CREATED_AT),
    -- Items are soft-deleted normally, but the recycle bin's 30-day purge is a
    -- hard DELETE, and a match must not outlive its item.
    CONSTRAINT fk_product_matches_item
        FOREIGN KEY (ITEM_ID) REFERENCES items (ID) ON DELETE CASCADE,
    CONSTRAINT fk_product_matches_product
        FOREIGN KEY (SELECTED_PRODUCT_ID) REFERENCES products (ID),
    CONSTRAINT fk_product_matches_user
        FOREIGN KEY (CREATED_BY) REFERENCES users (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
