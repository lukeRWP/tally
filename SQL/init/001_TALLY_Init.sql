-- TALLY Database Initialization
-- Creates the TALLY database and all tables in FK-dependency order.

CREATE DATABASE IF NOT EXISTS TALLY
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE TALLY;

-- ============================================================
-- 1. users
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    ID              INT          NOT NULL AUTO_INCREMENT,
    ENTRA_ID        VARCHAR(255) NOT NULL,
    EMAIL           VARCHAR(255) NOT NULL,
    DISPLAY_NAME    VARCHAR(255) NOT NULL,
    AVATAR_URL      TEXT         NULL,
    CREATED_AT      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    LAST_LOGIN_AT   DATETIME     NULL,
    PRIMARY KEY (ID),
    UNIQUE KEY uq_users_entra_id (ENTRA_ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 2. products
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
    ID                  INT             NOT NULL AUTO_INCREMENT,
    BARCODE             VARCHAR(50)     NULL,
    NAME                VARCHAR(255)    NOT NULL,
    BRAND               VARCHAR(255)    NULL,
    CATEGORY            VARCHAR(100)    NULL,
    DESCRIPTION         TEXT            NULL,
    SPECS               JSON            NULL,
    IMAGE_URL           TEXT            NULL,
    RETAIL_PRICE        DECIMAL(10,2)   NULL,
    RETAIL_LINKS        JSON            NULL,
    DEPRECIATION_RATE   DECIMAL(5,4)    NULL,
    DATA_SOURCE         ENUM('upc_db','open_food_facts','scrape','manual') NULL,
    CREATED_AT          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UPDATED_AT          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (ID),
    UNIQUE KEY uq_products_barcode (BARCODE),
    FULLTEXT KEY ft_products_search (NAME, BRAND, DESCRIPTION)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 3. properties
-- ============================================================
CREATE TABLE IF NOT EXISTS properties (
    ID          INT          NOT NULL AUTO_INCREMENT,
    NAME        VARCHAR(255) NOT NULL,
    ADDRESS     TEXT         NULL,
    DESCRIPTION TEXT         NULL,
    OWNER_ID    INT          NOT NULL,
    QR_CODE     VARCHAR(20)  NULL,
    CREATED_AT  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UPDATED_AT  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    DELETED_AT  DATETIME     NULL,
    PRIMARY KEY (ID),
    UNIQUE KEY uq_properties_qr_code (QR_CODE),
    CONSTRAINT fk_properties_owner FOREIGN KEY (OWNER_ID) REFERENCES users (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 4. property_members
-- ============================================================
CREATE TABLE IF NOT EXISTS property_members (
    ID          INT                             NOT NULL AUTO_INCREMENT,
    PROPERTY_ID INT                             NOT NULL,
    USER_ID     INT                             NOT NULL,
    ROLE        ENUM('owner','editor','viewer') NOT NULL,
    INVITED_BY  INT                             NULL,
    CREATED_AT  DATETIME                        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ID),
    UNIQUE KEY uq_property_members_prop_user (PROPERTY_ID, USER_ID),
    CONSTRAINT fk_property_members_property  FOREIGN KEY (PROPERTY_ID) REFERENCES properties (ID),
    CONSTRAINT fk_property_members_user      FOREIGN KEY (USER_ID)     REFERENCES users (ID),
    CONSTRAINT fk_property_members_invited   FOREIGN KEY (INVITED_BY)  REFERENCES users (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 5. areas
-- ============================================================
CREATE TABLE IF NOT EXISTS areas (
    ID          INT          NOT NULL AUTO_INCREMENT,
    PROPERTY_ID INT          NOT NULL,
    NAME        VARCHAR(255) NOT NULL,
    DESCRIPTION TEXT         NULL,
    QR_CODE     VARCHAR(20)  NULL,
    CREATED_AT  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UPDATED_AT  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    DELETED_AT  DATETIME     NULL,
    PRIMARY KEY (ID),
    UNIQUE KEY uq_areas_qr_code (QR_CODE),
    FULLTEXT KEY ft_areas_name (NAME),
    CONSTRAINT fk_areas_property FOREIGN KEY (PROPERTY_ID) REFERENCES properties (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 6. containers
-- ============================================================
CREATE TABLE IF NOT EXISTS containers (
    ID                   INT          NOT NULL AUTO_INCREMENT,
    AREA_ID              INT          NOT NULL,
    PARENT_CONTAINER_ID  INT          NULL,
    NAME                 VARCHAR(255) NOT NULL,
    TYPE                 VARCHAR(50)  NULL,
    DESCRIPTION          TEXT         NULL,
    QR_CODE              VARCHAR(20)  NULL,
    CREATED_AT           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UPDATED_AT           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    DELETED_AT           DATETIME     NULL,
    PRIMARY KEY (ID),
    UNIQUE KEY uq_containers_qr_code (QR_CODE),
    FULLTEXT KEY ft_containers_name (NAME),
    CONSTRAINT fk_containers_area   FOREIGN KEY (AREA_ID)             REFERENCES areas (ID),
    CONSTRAINT fk_containers_parent FOREIGN KEY (PARENT_CONTAINER_ID) REFERENCES containers (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 7. container_paths  (closure table)
-- ============================================================
CREATE TABLE IF NOT EXISTS container_paths (
    ANCESTOR_ID   INT NOT NULL,
    DESCENDANT_ID INT NOT NULL,
    DEPTH         INT NOT NULL,
    PRIMARY KEY (ANCESTOR_ID, DESCENDANT_ID),
    KEY idx_container_paths_descendant (DESCENDANT_ID),
    CONSTRAINT fk_container_paths_ancestor   FOREIGN KEY (ANCESTOR_ID)   REFERENCES containers (ID),
    CONSTRAINT fk_container_paths_descendant FOREIGN KEY (DESCENDANT_ID) REFERENCES containers (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 8. items
-- ============================================================
CREATE TABLE IF NOT EXISTS items (
    ID                    INT                              NOT NULL AUTO_INCREMENT,
    CONTAINER_ID          INT                              NOT NULL,
    PRODUCT_ID            INT                              NULL,
    NAME                  VARCHAR(255)                     NOT NULL,
    DESCRIPTION           TEXT                             NULL,
    QUANTITY              INT                              NOT NULL DEFAULT 1,
    PURCHASE_PRICE        DECIMAL(10,2)                    NULL,
    CURRENT_VALUE         DECIMAL(10,2)                    NULL,
    DEPRECIATION_ENABLED  BOOLEAN                          NOT NULL DEFAULT FALSE,
    DEPRECIATION_RATE     DECIMAL(5,4)                     NULL,
    CONDITION             ENUM('new','good','fair','poor') NULL,
    QR_CODE               VARCHAR(20)                      NULL,
    STATUS                ENUM('active','removed','lent')  NOT NULL DEFAULT 'active',
    CREATED_AT            DATETIME                         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UPDATED_AT            DATETIME                         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    DELETED_AT            DATETIME                         NULL,
    PRIMARY KEY (ID),
    UNIQUE KEY uq_items_qr_code (QR_CODE),
    FULLTEXT KEY ft_items_search (NAME, DESCRIPTION),
    CONSTRAINT fk_items_container FOREIGN KEY (CONTAINER_ID) REFERENCES containers (ID),
    CONSTRAINT fk_items_product   FOREIGN KEY (PRODUCT_ID)   REFERENCES products (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 9. item_dates
-- ============================================================
CREATE TABLE IF NOT EXISTS item_dates (
    ID          INT         NOT NULL AUTO_INCREMENT,
    ITEM_ID     INT         NOT NULL,
    DATE_TYPE   VARCHAR(50) NOT NULL,
    DATE_VALUE  DATE        NOT NULL,
    NOTES       TEXT        NULL,
    PRIMARY KEY (ID),
    CONSTRAINT fk_item_dates_item FOREIGN KEY (ITEM_ID) REFERENCES items (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 10. item_accessories
-- ============================================================
CREATE TABLE IF NOT EXISTS item_accessories (
    ID           INT NOT NULL AUTO_INCREMENT,
    ITEM_ID      INT NOT NULL,
    ACCESSORY_ID INT NOT NULL,
    PRIMARY KEY (ID),
    CONSTRAINT fk_item_accessories_item      FOREIGN KEY (ITEM_ID)      REFERENCES items (ID),
    CONSTRAINT fk_item_accessories_accessory FOREIGN KEY (ACCESSORY_ID) REFERENCES items (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 11. condition_snapshots
-- ============================================================
CREATE TABLE IF NOT EXISTS condition_snapshots (
    ID          INT                              NOT NULL AUTO_INCREMENT,
    ITEM_ID     INT                              NOT NULL,
    CONDITION   ENUM('new','good','fair','poor') NOT NULL,
    PHOTO_KEY   VARCHAR(255)                     NOT NULL,
    NOTES       TEXT                             NULL,
    RECORDED_BY INT                              NOT NULL,
    CREATED_AT  DATETIME                         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ID),
    CONSTRAINT fk_condition_snapshots_item FOREIGN KEY (ITEM_ID)     REFERENCES items (ID),
    CONSTRAINT fk_condition_snapshots_user FOREIGN KEY (RECORDED_BY) REFERENCES users (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 12. item_files
-- ============================================================
CREATE TABLE IF NOT EXISTS item_files (
    ID           INT                                               NOT NULL AUTO_INCREMENT,
    ITEM_ID      INT                                               NOT NULL,
    FILE_TYPE    ENUM('receipt','warranty','manual','photo','other') NOT NULL,
    FILE_KEY     VARCHAR(255)                                      NOT NULL,
    FILE_NAME    VARCHAR(255)                                      NOT NULL,
    MIME_TYPE    VARCHAR(100)                                      NOT NULL,
    FILE_SIZE    INT                                               NOT NULL,
    UPLOADED_BY  INT                                               NOT NULL,
    CREATED_AT   DATETIME                                          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ID),
    CONSTRAINT fk_item_files_item FOREIGN KEY (ITEM_ID)     REFERENCES items (ID),
    CONSTRAINT fk_item_files_user FOREIGN KEY (UPLOADED_BY) REFERENCES users (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 13. item_lending
-- ============================================================
CREATE TABLE IF NOT EXISTS item_lending (
    ID           INT          NOT NULL AUTO_INCREMENT,
    ITEM_ID      INT          NOT NULL,
    LENT_TO      VARCHAR(255) NOT NULL,
    LENT_AT      DATETIME     NOT NULL,
    DUE_AT       DATETIME     NULL,
    RETURNED_AT  DATETIME     NULL,
    NOTES        TEXT         NULL,
    CREATED_BY   INT          NOT NULL,
    PRIMARY KEY (ID),
    CONSTRAINT fk_item_lending_item FOREIGN KEY (ITEM_ID)    REFERENCES items (ID),
    CONSTRAINT fk_item_lending_user FOREIGN KEY (CREATED_BY) REFERENCES users (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 14. tags
-- ============================================================
CREATE TABLE IF NOT EXISTS tags (
    ID          INT         NOT NULL AUTO_INCREMENT,
    NAME        VARCHAR(50) NOT NULL,
    COLOR       VARCHAR(7)  NOT NULL,
    PROPERTY_ID INT         NOT NULL,
    PRIMARY KEY (ID),
    UNIQUE KEY uq_tags_name_property (NAME, PROPERTY_ID),
    CONSTRAINT fk_tags_property FOREIGN KEY (PROPERTY_ID) REFERENCES properties (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 15. entity_tags
-- ============================================================
CREATE TABLE IF NOT EXISTS entity_tags (
    TAG_ID      INT                                  NOT NULL,
    ENTITY_TYPE ENUM('item','container','area')      NOT NULL,
    ENTITY_ID   INT                                  NOT NULL,
    UNIQUE KEY uq_entity_tags (TAG_ID, ENTITY_TYPE, ENTITY_ID),
    CONSTRAINT fk_entity_tags_tag FOREIGN KEY (TAG_ID) REFERENCES tags (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 16. change_log
-- ============================================================
CREATE TABLE IF NOT EXISTS change_log (
    ID          INT                                                                  NOT NULL AUTO_INCREMENT,
    USER_ID     INT                                                                  NOT NULL,
    ENTITY_TYPE ENUM('property','area','container','item')                           NOT NULL,
    ENTITY_ID   INT                                                                  NOT NULL,
    ACTION      ENUM('created','updated','moved','deleted','restored','lent','returned') NOT NULL,
    CHANGES     JSON                                                                 NULL,
    PROPERTY_ID INT                                                                  NOT NULL,
    CREATED_AT  DATETIME                                                             NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ID),
    KEY idx_change_log_property_created (PROPERTY_ID, CREATED_AT),
    CONSTRAINT fk_change_log_user     FOREIGN KEY (USER_ID)     REFERENCES users (ID),
    CONSTRAINT fk_change_log_property FOREIGN KEY (PROPERTY_ID) REFERENCES properties (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 17. notifications
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
    ID          INT                                                                                   NOT NULL AUTO_INCREMENT,
    USER_ID     INT                                                                                   NOT NULL,
    TYPE        ENUM('warranty_expiry','lending_due','item_moved','item_removed','share_expiring','custom_date') NOT NULL,
    TITLE       VARCHAR(255)                                                                          NOT NULL,
    MESSAGE     TEXT                                                                                  NOT NULL,
    ENTITY_TYPE ENUM('property','area','container','item')                                            NULL,
    ENTITY_ID   INT                                                                                   NULL,
    READ_AT     DATETIME                                                                              NULL,
    CREATED_AT  DATETIME                                                                              NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ID),
    CONSTRAINT fk_notifications_user FOREIGN KEY (USER_ID) REFERENCES users (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 18. notification_preferences
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_preferences (
    USER_ID           INT                                                                                   NOT NULL,
    NOTIFICATION_TYPE ENUM('warranty_expiry','lending_due','item_moved','item_removed','share_expiring','custom_date') NOT NULL,
    ENABLED           BOOLEAN                                                                               NOT NULL DEFAULT FALSE,
    UNIQUE KEY uq_notification_preferences (USER_ID, NOTIFICATION_TYPE),
    CONSTRAINT fk_notification_preferences_user FOREIGN KEY (USER_ID) REFERENCES users (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 19. share_links
-- ============================================================
CREATE TABLE IF NOT EXISTS share_links (
    ID          INT                                    NOT NULL AUTO_INCREMENT,
    TOKEN       VARCHAR(64)                            NOT NULL,
    ENTITY_TYPE ENUM('property','area','container','item') NOT NULL,
    ENTITY_ID   INT                                    NOT NULL,
    CREATED_BY  INT                                    NOT NULL,
    EXPIRES_AT  DATETIME                               NOT NULL,
    CREATED_AT  DATETIME                               NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ID),
    UNIQUE KEY uq_share_links_token (TOKEN),
    CONSTRAINT fk_share_links_user FOREIGN KEY (CREATED_BY) REFERENCES users (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 20. sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
    ID         INT         NOT NULL AUTO_INCREMENT,
    USER_ID    INT         NOT NULL,
    TOKEN      VARCHAR(64) NOT NULL,
    EXPIRES_AT DATETIME    NOT NULL,
    CREATED_AT DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ID),
    UNIQUE KEY uq_sessions_token (TOKEN),
    CONSTRAINT fk_sessions_user FOREIGN KEY (USER_ID) REFERENCES users (ID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
