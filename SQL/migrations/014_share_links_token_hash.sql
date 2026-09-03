-- 014: share_links.TOKEN becomes a SHA-256 digest of the token (#349).
--
-- The raw token is the whole credential for a public share page, and it sat
-- in the table verbatim: anyone with a read of share_links held every live
-- link. From here on `create` returns the raw token exactly once (in the URL)
-- and stores SHA2(token, 256); `validate` hashes what arrives and looks the
-- digest up. Existing links keep working — the URL a household member already
-- sent out still hashes to what this migration writes — but the list can no
-- longer show a URL for them, which is the point.
--
-- TOKEN_HASHED is the idempotency guard AND the deploy-window marker. A raw
-- token and a SHA-256 digest are both 64 hex characters, so nothing about the
-- value itself says which it is; the migration gate applies every migration
-- twice, and a second `UPDATE ... SET TOKEN = SHA2(TOKEN, 256)` would silently
-- kill every link. The flag makes the rewrite a no-op on rows already hashed.
-- It also names the rows the OLD server writes between this migration running
-- and the dependent code deploying: those insert with the column default 0
-- and stay plaintext. The new `validate` only matches TOKEN_HASHED = 1, so
-- such a row is a dead link that the expiry purge removes in due course —
-- honest, rather than a raw token matched against a hash forever.
--
-- Idempotent via the 002 information_schema-guard pattern (MySQL 8 has no
-- `ADD COLUMN ... IF NOT EXISTS`). No `USE` statement, unqualified table
-- name: the migrate-all playbook selects the app database itself.

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'share_links'
     AND COLUMN_NAME  = 'TOKEN_HASHED'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE share_links ADD COLUMN TOKEN_HASHED TINYINT(1) NOT NULL DEFAULT 0 AFTER TOKEN',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Rewrite in place. SHA2(x, 256) here and crypto sha256 hex in Node agree for
-- the ASCII tokens create() has always written.
UPDATE share_links
   SET TOKEN = SHA2(TOKEN, 256), TOKEN_HASHED = 1
 WHERE TOKEN_HASHED = 0;
