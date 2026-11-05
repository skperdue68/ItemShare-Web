-- Guild membership per ESO account.
-- Replaced in full on every upload, exactly like the item list, so leaving a
-- guild in game removes that guild's visibility after the next upload.

CREATE TABLE IF NOT EXISTS itemshare_account_guilds (
  account_name VARCHAR(96) NOT NULL,
  guild_id BIGINT UNSIGNED NOT NULL,
  first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_name, guild_id),
  KEY idx_itemshare_account_guilds_guild (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
