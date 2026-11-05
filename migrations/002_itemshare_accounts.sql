-- Discord identity linked to an ESO account, and per-upload totals.
-- The link is created automatically the first time a logged in user uploads a
-- saved variables file belonging to that ESO account.

CREATE TABLE IF NOT EXISTS itemshare_accounts (
  eso_account_name VARCHAR(96) NOT NULL,
  discord_user_id VARCHAR(32) NOT NULL,
  discord_username VARCHAR(96) NOT NULL DEFAULT '',
  linked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (eso_account_name),
  KEY idx_itemshare_accounts_discord (discord_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE itemshare_uploads
  ADD COLUMN IF NOT EXISTS total_quantity INT UNSIGNED NOT NULL DEFAULT 0;

ALTER TABLE itemshare_uploads
  ADD COLUMN IF NOT EXISTS discord_user_id VARCHAR(32) NOT NULL DEFAULT '';
