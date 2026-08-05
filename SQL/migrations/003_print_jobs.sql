-- Phase 2 auto-print: the job queue and the Pi agents that drain it.
--
-- printer_agents: one row per Raspberry Pi. TOKEN_HASH is the SHA-256 of the
-- agent's bearer token — the plaintext is shown once at creation and never
-- stored, because this is a long-lived credential that prints on a user's
-- behalf (unlike share_links, whose 7-day plaintext token is acceptable).
-- LOADED_MEDIA is the roll physically in the printer; tally is the single
-- source of truth for it (the Pi cannot sense roll size and does not store it).
-- It has no 'sheet' value: Avery sheets are Letter-size laser output.
--
-- print_jobs: stores the PARAMETERS of a print, not the rendered bytes — the
-- PDF is rendered on demand at fetch time from the Phase 1 renderers.
--
-- No `USE` statement — the migrate playbook selects the app DB (-D TALLY).

CREATE TABLE IF NOT EXISTS printer_agents (
    ID                    INT          NOT NULL AUTO_INCREMENT,
    PROPERTY_ID           INT          NOT NULL,
    NAME                  VARCHAR(100) NOT NULL,
    TOKEN_HASH            CHAR(64)     NOT NULL,
    LOADED_MEDIA          ENUM('small','medium','large') NOT NULL DEFAULT 'large',
    PRINTER_STATE         ENUM('idle','printing','stopped','unknown') NOT NULL DEFAULT 'unknown',
    PRINTER_STATE_REASONS JSON         NULL,
    LAST_SEEN_AT          DATETIME     NULL,
    CREATED_AT            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ID),
    UNIQUE KEY uq_printer_agents_token (TOKEN_HASH),
    KEY idx_printer_agents_property (PROPERTY_ID),
    CONSTRAINT fk_printer_agents_property FOREIGN KEY (PROPERTY_ID) REFERENCES properties (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS print_jobs (
    ID          INT NOT NULL AUTO_INCREMENT,
    PROPERTY_ID INT NOT NULL,
    CREATED_BY  INT NOT NULL,
    ENTITY_TYPE ENUM('item','container','area') NOT NULL,
    ENTITY_IDS  JSON NOT NULL,
    PRESET      ENUM('small','medium','large') NOT NULL,
    STATUS      ENUM('queued','held','claimed','done','failed','canceled') NOT NULL DEFAULT 'queued',
    ATTEMPTS    INT NOT NULL DEFAULT 0,
    LAST_ERROR  VARCHAR(500) NULL,
    CLAIM_ID    CHAR(36) NULL,
    CLAIMED_BY  INT NULL,
    CLAIMED_AT  DATETIME NULL,
    PRINTED_AT  DATETIME NULL,
    CREATED_AT  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UPDATED_AT  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (ID),
    -- the claim query seeks on (PROPERTY_ID, STATUS, PRESET) ordered by CREATED_AT
    KEY idx_print_jobs_claim (PROPERTY_ID, STATUS, PRESET, CREATED_AT),
    KEY idx_print_jobs_claim_id (CLAIM_ID),
    CONSTRAINT fk_print_jobs_property FOREIGN KEY (PROPERTY_ID) REFERENCES properties (ID),
    CONSTRAINT fk_print_jobs_user     FOREIGN KEY (CREATED_BY)  REFERENCES users (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
