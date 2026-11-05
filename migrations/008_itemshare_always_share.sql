-- Standing offers: items the owner will hand out whenever they have one.
--
-- Deliberately separate from itemshare_shared_items. These rows carry no count
-- and no location, because the owner does not necessarily have the item; the
-- site lists them as an offer rather than as inventory. Keeping them in their
-- own table also means the addon's rebuild pass, which prunes inventory entries
-- missing from a readable bag, can never delete them.

CREATE TABLE IF NOT EXISTS itemshare_always_share (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_name VARCHAR(96) NOT NULL,
  character_name VARCHAR(96) NOT NULL DEFAULT '',
  item_key TEXT NOT NULL,
  -- SHA-1 of item_key, so the uniqueness rule stays inside index byte limits.
  item_key_hash CHAR(40) NOT NULL,
  item_link VARCHAR(1024) NOT NULL DEFAULT '',
  item_name VARCHAR(255) NOT NULL DEFAULT '',
  item_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  icon VARCHAR(255) NOT NULL DEFAULT '',
  icon_key CHAR(40) NOT NULL DEFAULT '',
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
  set_name VARCHAR(255) NOT NULL DEFAULT '',
  enchant_name VARCHAR(255) NOT NULL DEFAULT '',
  style_name VARCHAR(128) NOT NULL DEFAULT '',
  required_level INT NOT NULL DEFAULT 0,
  required_cp INT NOT NULL DEFAULT 0,
  flavor_text TEXT NULL,
  eso_data JSON NULL,
  furniture_data_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  first_added_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_updated_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
  upload_id BIGINT UNSIGNED NULL,
  first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_itemshare_always_share (account_name, item_key_hash),
  KEY idx_itemshare_always_share_name (item_name),
  KEY idx_itemshare_always_share_type (item_type_name),
  CONSTRAINT fk_itemshare_always_share_upload
    FOREIGN KEY (upload_id) REFERENCES itemshare_uploads (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS itemshare_always_share_guilds (
  always_share_id BIGINT UNSIGNED NOT NULL,
  guild_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (always_share_id, guild_id),
  KEY idx_itemshare_always_share_guilds_guild (guild_id),
  CONSTRAINT fk_itemshare_always_share_guilds_row
    FOREIGN KEY (always_share_id) REFERENCES itemshare_always_share (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
