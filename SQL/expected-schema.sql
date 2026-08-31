-- SQL/expected-schema.sql — the schema SQL/init + SQL/migrations must produce.
--
-- GENERATED FILE. Do not hand-edit. Any PR that adds or changes a migration
-- must regenerate it, or the CI migration gate fails on schema drift:
--
--     SQL/ci/migration-gate.sh --write
--
-- (Needs docker; nothing else. It boots a throwaway MySQL 8.4, applies
-- SQL/init/001_TALLY_Init.sql then every SQL/migrations/*.sql in order, and
-- writes the normalised `mysqldump --no-data` of the result here.)
--
-- Normalisation, so the comparison is a stable byte diff: tables are dumped in
-- C-collation name order, mysqldump runs --compact (no banner, no dump date,
-- no session-variable preamble), and AUTO_INCREMENT counters are stripped.
--
-- This file is what catches the base schema drifting ahead of the migration
-- chain — the underlying cause of the 2026-08-15 outage, where indexes were
-- folded into 001 while 002 still added them unguarded.

CREATE TABLE `areas` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `PROPERTY_ID` int NOT NULL,
  `NAME` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `DESCRIPTION` text COLLATE utf8mb4_unicode_ci,
  `QR_CODE` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `CREATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `UPDATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `DELETED_AT` datetime DEFAULT NULL,
  `DELETE_BATCH_ID` int DEFAULT NULL,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_areas_qr_code` (`QR_CODE`),
  KEY `fk_areas_property` (`PROPERTY_ID`),
  KEY `idx_areas_delete_batch` (`DELETE_BATCH_ID`),
  FULLTEXT KEY `ft_areas_name` (`NAME`),
  CONSTRAINT `fk_areas_delete_batch` FOREIGN KEY (`DELETE_BATCH_ID`) REFERENCES `delete_batches` (`ID`),
  CONSTRAINT `fk_areas_property` FOREIGN KEY (`PROPERTY_ID`) REFERENCES `properties` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `change_log` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `USER_ID` int NOT NULL,
  `ENTITY_TYPE` enum('property','area','container','item') COLLATE utf8mb4_unicode_ci NOT NULL,
  `ENTITY_ID` int NOT NULL,
  `ACTION` enum('created','updated','moved','deleted','restored','lent','returned') COLLATE utf8mb4_unicode_ci NOT NULL,
  `CHANGES` json DEFAULT NULL,
  `PROPERTY_ID` int NOT NULL,
  `CREATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`ID`),
  KEY `idx_change_log_property_created` (`PROPERTY_ID`,`CREATED_AT`),
  KEY `idx_change_log_entity` (`ENTITY_TYPE`,`ENTITY_ID`,`CREATED_AT`),
  KEY `fk_change_log_user` (`USER_ID`),
  CONSTRAINT `fk_change_log_property` FOREIGN KEY (`PROPERTY_ID`) REFERENCES `properties` (`ID`),
  CONSTRAINT `fk_change_log_user` FOREIGN KEY (`USER_ID`) REFERENCES `users` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `condition_snapshots` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `ITEM_ID` int NOT NULL,
  `CONDITION` enum('new','good','fair','poor') COLLATE utf8mb4_unicode_ci NOT NULL,
  `PHOTO_KEY` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `NOTES` text COLLATE utf8mb4_unicode_ci,
  `RECORDED_BY` int NOT NULL,
  `CREATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`ID`),
  KEY `fk_condition_snapshots_item` (`ITEM_ID`),
  KEY `fk_condition_snapshots_user` (`RECORDED_BY`),
  CONSTRAINT `fk_condition_snapshots_item` FOREIGN KEY (`ITEM_ID`) REFERENCES `items` (`ID`),
  CONSTRAINT `fk_condition_snapshots_user` FOREIGN KEY (`RECORDED_BY`) REFERENCES `users` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `container_paths` (
  `ANCESTOR_ID` int NOT NULL,
  `DESCENDANT_ID` int NOT NULL,
  `DEPTH` int NOT NULL,
  PRIMARY KEY (`ANCESTOR_ID`,`DESCENDANT_ID`),
  KEY `idx_container_paths_descendant` (`DESCENDANT_ID`),
  CONSTRAINT `fk_container_paths_ancestor` FOREIGN KEY (`ANCESTOR_ID`) REFERENCES `containers` (`ID`),
  CONSTRAINT `fk_container_paths_descendant` FOREIGN KEY (`DESCENDANT_ID`) REFERENCES `containers` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `containers` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `AREA_ID` int NOT NULL,
  `PARENT_CONTAINER_ID` int DEFAULT NULL,
  `NAME` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `TYPE` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `DESCRIPTION` text COLLATE utf8mb4_unicode_ci,
  `QR_CODE` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `CREATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `UPDATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `DELETED_AT` datetime DEFAULT NULL,
  `DELETE_BATCH_ID` int DEFAULT NULL,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_containers_qr_code` (`QR_CODE`),
  KEY `fk_containers_area` (`AREA_ID`),
  KEY `fk_containers_parent` (`PARENT_CONTAINER_ID`),
  KEY `idx_containers_delete_batch` (`DELETE_BATCH_ID`),
  FULLTEXT KEY `ft_containers_name` (`NAME`),
  CONSTRAINT `fk_containers_area` FOREIGN KEY (`AREA_ID`) REFERENCES `areas` (`ID`),
  CONSTRAINT `fk_containers_delete_batch` FOREIGN KEY (`DELETE_BATCH_ID`) REFERENCES `delete_batches` (`ID`),
  CONSTRAINT `fk_containers_parent` FOREIGN KEY (`PARENT_CONTAINER_ID`) REFERENCES `containers` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `delete_batches` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `PROPERTY_ID` int NOT NULL,
  `ROOT_TYPE` enum('area','container','item') COLLATE utf8mb4_unicode_ci NOT NULL,
  `ROOT_ID` int NOT NULL,
  `ROOT_NAME` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `DELETED_BY` int DEFAULT NULL,
  `DELETED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`ID`),
  KEY `idx_delete_batches_property` (`PROPERTY_ID`,`DELETED_AT`),
  KEY `idx_delete_batches_root` (`ROOT_TYPE`,`ROOT_ID`),
  KEY `fk_delete_batches_user` (`DELETED_BY`),
  CONSTRAINT `fk_delete_batches_property` FOREIGN KEY (`PROPERTY_ID`) REFERENCES `properties` (`ID`),
  CONSTRAINT `fk_delete_batches_user` FOREIGN KEY (`DELETED_BY`) REFERENCES `users` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `entity_tags` (
  `TAG_ID` int NOT NULL,
  `ENTITY_TYPE` enum('item','container','area') COLLATE utf8mb4_unicode_ci NOT NULL,
  `ENTITY_ID` int NOT NULL,
  UNIQUE KEY `uq_entity_tags` (`TAG_ID`,`ENTITY_TYPE`,`ENTITY_ID`),
  KEY `idx_entity_tags_entity` (`ENTITY_TYPE`,`ENTITY_ID`),
  CONSTRAINT `fk_entity_tags_tag` FOREIGN KEY (`TAG_ID`) REFERENCES `tags` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `item_accessories` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `ITEM_ID` int NOT NULL,
  `ACCESSORY_ID` int NOT NULL,
  PRIMARY KEY (`ID`),
  KEY `fk_item_accessories_item` (`ITEM_ID`),
  KEY `fk_item_accessories_accessory` (`ACCESSORY_ID`),
  CONSTRAINT `fk_item_accessories_accessory` FOREIGN KEY (`ACCESSORY_ID`) REFERENCES `items` (`ID`),
  CONSTRAINT `fk_item_accessories_item` FOREIGN KEY (`ITEM_ID`) REFERENCES `items` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `item_dates` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `ITEM_ID` int NOT NULL,
  `DATE_TYPE` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `DATE_VALUE` date NOT NULL,
  `NOTES` text COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`ID`),
  KEY `fk_item_dates_item` (`ITEM_ID`),
  CONSTRAINT `fk_item_dates_item` FOREIGN KEY (`ITEM_ID`) REFERENCES `items` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `item_files` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `ITEM_ID` int NOT NULL,
  `FILE_TYPE` enum('receipt','warranty','manual','photo','other') COLLATE utf8mb4_unicode_ci NOT NULL,
  `FILE_KEY` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `THUMB_KEY` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `FILE_NAME` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `MIME_TYPE` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `FILE_SIZE` int NOT NULL,
  `UPLOADED_BY` int NOT NULL,
  `CREATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`ID`),
  KEY `fk_item_files_item` (`ITEM_ID`),
  KEY `fk_item_files_user` (`UPLOADED_BY`),
  CONSTRAINT `fk_item_files_item` FOREIGN KEY (`ITEM_ID`) REFERENCES `items` (`ID`),
  CONSTRAINT `fk_item_files_user` FOREIGN KEY (`UPLOADED_BY`) REFERENCES `users` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `item_lending` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `ITEM_ID` int NOT NULL,
  `LENT_TO` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `LENT_AT` datetime NOT NULL,
  `DUE_AT` datetime DEFAULT NULL,
  `RETURNED_AT` datetime DEFAULT NULL,
  `NOTES` text COLLATE utf8mb4_unicode_ci,
  `CREATED_BY` int NOT NULL,
  PRIMARY KEY (`ID`),
  KEY `fk_item_lending_item` (`ITEM_ID`),
  KEY `fk_item_lending_user` (`CREATED_BY`),
  CONSTRAINT `fk_item_lending_item` FOREIGN KEY (`ITEM_ID`) REFERENCES `items` (`ID`),
  CONSTRAINT `fk_item_lending_user` FOREIGN KEY (`CREATED_BY`) REFERENCES `users` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `items` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `CONTAINER_ID` int NOT NULL,
  `PRODUCT_ID` int DEFAULT NULL,
  `NAME` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `DESCRIPTION` text COLLATE utf8mb4_unicode_ci,
  `QUANTITY` int NOT NULL DEFAULT '1',
  `PURCHASE_PRICE` decimal(10,2) DEFAULT NULL,
  `CURRENT_VALUE` decimal(10,2) DEFAULT NULL,
  `CURRENT_VALUE_IS_ESTIMATE` tinyint(1) NOT NULL DEFAULT '0',
  `DEPRECIATION_ENABLED` tinyint(1) NOT NULL DEFAULT '0',
  `DEPRECIATION_RATE` decimal(5,4) DEFAULT NULL,
  `CONDITION` enum('new','good','fair','poor') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `COMPLETENESS` enum('complete','box_only','accessories_only') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'complete',
  `QR_CODE` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `STATUS` enum('active','removed','lent') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `CREATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `UPDATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `DELETED_AT` datetime DEFAULT NULL,
  `DELETE_BATCH_ID` int DEFAULT NULL,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_items_qr_code` (`QR_CODE`),
  KEY `fk_items_product` (`PRODUCT_ID`),
  KEY `idx_items_delete_batch` (`DELETE_BATCH_ID`),
  KEY `idx_items_container_status` (`CONTAINER_ID`,`STATUS`,`DELETED_AT`),
  KEY `idx_items_deleted_at` (`DELETED_AT`),
  FULLTEXT KEY `ft_items_search` (`NAME`,`DESCRIPTION`),
  CONSTRAINT `fk_items_container` FOREIGN KEY (`CONTAINER_ID`) REFERENCES `containers` (`ID`),
  CONSTRAINT `fk_items_delete_batch` FOREIGN KEY (`DELETE_BATCH_ID`) REFERENCES `delete_batches` (`ID`),
  CONSTRAINT `fk_items_product` FOREIGN KEY (`PRODUCT_ID`) REFERENCES `products` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `notification_preferences` (
  `USER_ID` int NOT NULL,
  `NOTIFICATION_TYPE` enum('warranty_expiry','lending_due','item_moved','item_removed','share_expiring','custom_date') COLLATE utf8mb4_unicode_ci NOT NULL,
  `ENABLED` tinyint(1) NOT NULL DEFAULT '0',
  UNIQUE KEY `uq_notification_preferences` (`USER_ID`,`NOTIFICATION_TYPE`),
  CONSTRAINT `fk_notification_preferences_user` FOREIGN KEY (`USER_ID`) REFERENCES `users` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `notifications` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `USER_ID` int NOT NULL,
  `TYPE` enum('warranty_expiry','lending_due','item_moved','item_removed','share_expiring','custom_date') COLLATE utf8mb4_unicode_ci NOT NULL,
  `TITLE` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `MESSAGE` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `ENTITY_TYPE` enum('property','area','container','item','item_date','item_lending') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ENTITY_ID` int DEFAULT NULL,
  `READ_AT` datetime DEFAULT NULL,
  `CREATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`ID`),
  KEY `fk_notifications_user` (`USER_ID`),
  CONSTRAINT `fk_notifications_user` FOREIGN KEY (`USER_ID`) REFERENCES `users` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `oauth_state` (
  `STATE_KEY` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `CODE_VERIFIER` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `EXPIRES_AT` datetime NOT NULL,
  `CREATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`STATE_KEY`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `print_jobs` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `PROPERTY_ID` int NOT NULL,
  `CREATED_BY` int NOT NULL,
  `ENTITY_TYPE` enum('item','container','area') COLLATE utf8mb4_unicode_ci NOT NULL,
  `ENTITY_IDS` json NOT NULL,
  `PRESET` enum('small','medium','large') COLLATE utf8mb4_unicode_ci NOT NULL,
  `STATUS` enum('queued','held','claimed','done','failed','canceled') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'queued',
  `ATTEMPTS` int NOT NULL DEFAULT '0',
  `LAST_ERROR` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `CLAIM_ID` char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `CLAIMED_BY` int DEFAULT NULL,
  `CLAIMED_AT` datetime DEFAULT NULL,
  `PRINTED_AT` datetime DEFAULT NULL,
  `CREATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `UPDATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`ID`),
  KEY `idx_print_jobs_claim` (`PROPERTY_ID`,`STATUS`,`PRESET`,`CREATED_AT`),
  KEY `idx_print_jobs_claim_id` (`CLAIM_ID`),
  KEY `fk_print_jobs_user` (`CREATED_BY`),
  CONSTRAINT `fk_print_jobs_property` FOREIGN KEY (`PROPERTY_ID`) REFERENCES `properties` (`ID`),
  CONSTRAINT `fk_print_jobs_user` FOREIGN KEY (`CREATED_BY`) REFERENCES `users` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `printer_agents` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `PROPERTY_ID` int NOT NULL,
  `NAME` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `TOKEN_HASH` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `CREATED_BY` int DEFAULT NULL,
  `LOADED_MEDIA` enum('small','medium','large') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'large',
  `PRINTER_STATE` enum('idle','printing','stopped','unknown') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'unknown',
  `PRINTER_STATE_REASONS` json DEFAULT NULL,
  `LAST_SEEN_AT` datetime DEFAULT NULL,
  `CREATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_printer_agents_token` (`TOKEN_HASH`),
  KEY `idx_printer_agents_property` (`PROPERTY_ID`),
  KEY `fk_printer_agents_creator` (`CREATED_BY`),
  CONSTRAINT `fk_printer_agents_creator` FOREIGN KEY (`CREATED_BY`) REFERENCES `users` (`ID`),
  CONSTRAINT `fk_printer_agents_property` FOREIGN KEY (`PROPERTY_ID`) REFERENCES `properties` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `product_matches` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `ITEM_ID` int NOT NULL,
  `CREATED_BY` int NOT NULL,
  `STATUS` enum('queued','searching','ready','none','failed','resolved','dismissed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'queued',
  `SEARCH_QUERY` json DEFAULT NULL,
  `CANDIDATES` json DEFAULT NULL,
  `SELECTED_PRODUCT_ID` int DEFAULT NULL,
  `ATTEMPTS` int NOT NULL DEFAULT '0',
  `SEARCH_COUNT` int NOT NULL DEFAULT '0',
  `LAST_ERROR` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `SEARCH_STARTED_AT` datetime DEFAULT NULL,
  `CREATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `UPDATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `RESOLVED_AT` datetime DEFAULT NULL,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_product_matches_item` (`ITEM_ID`),
  KEY `ix_product_matches_status` (`STATUS`),
  KEY `ix_product_matches_creator` (`CREATED_BY`,`UPDATED_AT`),
  KEY `fk_product_matches_product` (`SELECTED_PRODUCT_ID`),
  CONSTRAINT `fk_product_matches_item` FOREIGN KEY (`ITEM_ID`) REFERENCES `items` (`ID`) ON DELETE CASCADE,
  CONSTRAINT `fk_product_matches_product` FOREIGN KEY (`SELECTED_PRODUCT_ID`) REFERENCES `products` (`ID`),
  CONSTRAINT `fk_product_matches_user` FOREIGN KEY (`CREATED_BY`) REFERENCES `users` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `products` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `BARCODE` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `NAME` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `BRAND` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `CATEGORY` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `DESCRIPTION` text COLLATE utf8mb4_unicode_ci,
  `SPECS` json DEFAULT NULL,
  `IMAGE_URL` text COLLATE utf8mb4_unicode_ci,
  `RETAIL_PRICE` decimal(10,2) DEFAULT NULL,
  `RETAIL_LINKS` json DEFAULT NULL,
  `DEPRECIATION_RATE` decimal(5,4) DEFAULT NULL,
  `DATA_SOURCE` enum('upc_db','open_food_facts','scrape','manual','vision_match') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `CREATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `UPDATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_products_barcode` (`BARCODE`),
  FULLTEXT KEY `ft_products_search` (`NAME`,`BRAND`,`DESCRIPTION`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `properties` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `NAME` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `ADDRESS` text COLLATE utf8mb4_unicode_ci,
  `DESCRIPTION` text COLLATE utf8mb4_unicode_ci,
  `OWNER_ID` int NOT NULL,
  `QR_CODE` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `CREATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `UPDATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `DELETED_AT` datetime DEFAULT NULL,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_properties_qr_code` (`QR_CODE`),
  KEY `fk_properties_owner` (`OWNER_ID`),
  CONSTRAINT `fk_properties_owner` FOREIGN KEY (`OWNER_ID`) REFERENCES `users` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `property_members` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `PROPERTY_ID` int NOT NULL,
  `USER_ID` int NOT NULL,
  `ROLE` enum('owner','editor','viewer') COLLATE utf8mb4_unicode_ci NOT NULL,
  `INVITED_BY` int DEFAULT NULL,
  `CREATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_property_members_prop_user` (`PROPERTY_ID`,`USER_ID`),
  KEY `fk_property_members_user` (`USER_ID`),
  KEY `fk_property_members_invited` (`INVITED_BY`),
  CONSTRAINT `fk_property_members_invited` FOREIGN KEY (`INVITED_BY`) REFERENCES `users` (`ID`),
  CONSTRAINT `fk_property_members_property` FOREIGN KEY (`PROPERTY_ID`) REFERENCES `properties` (`ID`),
  CONSTRAINT `fk_property_members_user` FOREIGN KEY (`USER_ID`) REFERENCES `users` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `sessions` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `USER_ID` int NOT NULL,
  `TOKEN` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `EXPIRES_AT` datetime NOT NULL,
  `CREATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_sessions_token` (`TOKEN`),
  KEY `fk_sessions_user` (`USER_ID`),
  CONSTRAINT `fk_sessions_user` FOREIGN KEY (`USER_ID`) REFERENCES `users` (`ID`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `share_links` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `TOKEN` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `ENTITY_TYPE` enum('property','area','container','item') COLLATE utf8mb4_unicode_ci NOT NULL,
  `ENTITY_ID` int NOT NULL,
  `CREATED_BY` int NOT NULL,
  `EXPIRES_AT` datetime NOT NULL,
  `DISCLOSURE` json DEFAULT NULL,
  `CREATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_share_links_token` (`TOKEN`),
  KEY `fk_share_links_user` (`CREATED_BY`),
  CONSTRAINT `fk_share_links_user` FOREIGN KEY (`CREATED_BY`) REFERENCES `users` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `tags` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `NAME` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `COLOR` varchar(7) COLLATE utf8mb4_unicode_ci NOT NULL,
  `PROPERTY_ID` int NOT NULL,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_tags_name_property` (`NAME`,`PROPERTY_ID`),
  KEY `fk_tags_property` (`PROPERTY_ID`),
  CONSTRAINT `fk_tags_property` FOREIGN KEY (`PROPERTY_ID`) REFERENCES `properties` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `users` (
  `ID` int NOT NULL AUTO_INCREMENT,
  `ENTRA_ID` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `EMAIL` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `DISPLAY_NAME` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `AVATAR_URL` text COLLATE utf8mb4_unicode_ci,
  `CREATED_AT` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `LAST_LOGIN_AT` datetime DEFAULT NULL,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_users_entra_id` (`ENTRA_ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `vision_usage` (
  `USER_ID` int NOT NULL,
  `DAY` date NOT NULL,
  `CALL_COUNT` int NOT NULL DEFAULT '0',
  `UPDATED_AT` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`USER_ID`,`DAY`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
