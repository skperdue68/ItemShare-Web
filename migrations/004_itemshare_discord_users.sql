-- Discord identity captured at sign-in, including the email address used when
-- an item request needs to notify an owner. Kept separate from
-- itemshare_accounts because a Discord user exists before they ever upload.
--
-- The email is personal data: it is only ever read server-side and shown back to
-- its own owner. Never include it in item lists or any other member's view.

CREATE TABLE IF NOT EXISTS itemshare_discord_users (
  discord_user_id VARCHAR(32) NOT NULL,
  discord_username VARCHAR(96) NOT NULL DEFAULT '',
  discord_email VARCHAR(254) NOT NULL DEFAULT '',
  email_verified TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (discord_user_id),
  KEY idx_itemshare_discord_users_email (discord_email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
