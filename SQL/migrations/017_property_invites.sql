-- 017: property invites through pwiam (plan 2026-09-26-property-invites.md).
--
-- A property owner invites a brand-new person straight into the property; the
-- grant that lets them sign in at all comes from pwiam (`POST /rp/invites`),
-- never from tally. This table is tally's half: the pending invite, keyed by
-- the invitee's pwiam `sub` rather than an email address. A self-asserted
-- email can be typed by anyone; a `sub` is pre-allocated by pwiam when the
-- ticket is minted and cannot be chosen by whoever redeems the link — see the
-- plan's "Why this shape".
--
-- A brand new table, not an ALTER — CREATE TABLE IF NOT EXISTS is its own
-- idempotency (rule 9); no information_schema guard needed.

CREATE TABLE IF NOT EXISTS property_invites (
    ID                INT                             NOT NULL AUTO_INCREMENT,
    PROPERTY_ID       INT                             NOT NULL,
    ROLE              ENUM('editor','viewer')         NOT NULL,
    DISPLAY_NAME      VARCHAR(120)                    NOT NULL,
    INVITEE_SUB       VARCHAR(26)                     NOT NULL,
    PWIAM_INVITE_ID   VARCHAR(26)                     NOT NULL,
    INVITED_BY        INT                             NOT NULL,
    EXPIRES_AT        DATETIME                        NOT NULL,
    ACCEPTED_AT       DATETIME                        NULL,
    ACCEPTED_USER_ID  INT                             NULL,
    REVOKED_AT        DATETIME                        NULL,
    CREATED_AT        DATETIME                        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ID),
    UNIQUE KEY uq_property_invites_pwiam_id (PWIAM_INVITE_ID),
    KEY idx_property_invites_invitee_sub (INVITEE_SUB),
    CONSTRAINT fk_property_invites_property FOREIGN KEY (PROPERTY_ID)      REFERENCES properties (ID),
    CONSTRAINT fk_property_invites_invited  FOREIGN KEY (INVITED_BY)      REFERENCES users (ID),
    CONSTRAINT fk_property_invites_accepted FOREIGN KEY (ACCEPTED_USER_ID) REFERENCES users (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
