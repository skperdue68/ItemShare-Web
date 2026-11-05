-- ItemShare stage one schema.
-- Every table is prefixed itemshare_ so this database can never be mistaken for
-- the GuildSync schema even when both live on the same MariaDB server.

CREATE TABLE IF NOT EXISTS itemshare_uploads (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_name VARCHAR(96) NOT NULL,
  character_name VARCHAR(96) NOT NULL,
  source_file VARCHAR(255) NOT NULL DEFAULT '',
  addon_version VARCHAR(32) NOT NULL DEFAULT '',
  item_count INT UNSIGNED NOT NULL DEFAULT 0,
  guild_count INT UNSIGNED NOT NULL DEFAULT 0,
  uploaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_itemshare_uploads_scope (account_name, character_name, uploaded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS itemshare_guilds (
  guild_id BIGINT UNSIGNED NOT NULL,
  guild_name VARCHAR(255) NOT NULL DEFAULT '',
  first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (guild_id),
  KEY idx_itemshare_guilds_name (guild_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS itemshare_shared_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_name VARCHAR(96) NOT NULL,
  character_name VARCHAR(96) NOT NULL,
  item_key TEXT NOT NULL,
  -- SHA-1 of item_key so the uniqueness rule stays inside index byte limits.
  item_key_hash CHAR(40) NOT NULL,
  item_link VARCHAR(1024) NOT NULL DEFAULT '',
  item_name VARCHAR(255) NOT NULL DEFAULT '',
  item_type INT NOT NULL DEFAULT 0,
  item_type_name VARCHAR(64) NOT NULL DEFAULT '',
  quality INT NOT NULL DEFAULT 0,
  quality_name VARCHAR(64) NOT NULL DEFAULT '',
  trait VARCHAR(128) NOT NULL DEFAULT '',
  trait_type VARCHAR(128) NOT NULL DEFAULT '',
  apparel_slot VARCHAR(64) NOT NULL DEFAULT '',
  equip_type VARCHAR(64) NOT NULL DEFAULT '',
  apparel_weight VARCHAR(64) NOT NULL DEFAULT '',
  armor_type VARCHAR(64) NOT NULL DEFAULT '',
  weapon_type VARCHAR(64) NOT NULL DEFAULT '',
  weapon_handedness VARCHAR(64) NOT NULL DEFAULT '',
  furniture_data_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  location_key VARCHAR(191) NOT NULL DEFAULT '',
  location_label VARCHAR(255) NOT NULL DEFAULT '',
  item_count INT NOT NULL DEFAULT 0,
  first_dumped_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_dumped_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
  upload_id BIGINT UNSIGNED NULL,
  first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_itemshare_shared_item (account_name, character_name, item_key_hash),
  KEY idx_itemshare_shared_items_name (item_name),
  KEY idx_itemshare_shared_items_type (item_type),
  KEY idx_itemshare_shared_items_location (location_key),
  CONSTRAINT fk_itemshare_shared_items_upload
    FOREIGN KEY (upload_id) REFERENCES itemshare_uploads (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which guilds each shared item is offered to. Guild IDs, not names, are the
-- key because names are neither unique nor stable.
CREATE TABLE IF NOT EXISTS itemshare_shared_item_guilds (
  item_id BIGINT UNSIGNED NOT NULL,
  guild_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (item_id, guild_id),
  KEY idx_itemshare_item_guilds_guild (guild_id),
  CONSTRAINT fk_itemshare_item_guilds_item
    FOREIGN KEY (item_id) REFERENCES itemshare_shared_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
