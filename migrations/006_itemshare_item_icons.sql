-- Item icons, cached locally.
--
-- The addon (1.4.0+) records the game's icon path per shared item, e.g.
-- /esoui/art/icons/gear_breton_2haxe_d.dds. Browsers cannot draw DDS, so each
-- icon is fetched once from UESP's PNG mirror and stored here. The site serves
-- the stored bytes afterwards and never asks UESP again for that icon.

ALTER TABLE itemshare_shared_items
  ADD COLUMN IF NOT EXISTS item_id BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER item_name;

ALTER TABLE itemshare_shared_items
  ADD COLUMN IF NOT EXISTS icon VARCHAR(255) NOT NULL DEFAULT '' AFTER item_name;

-- SHA-1 of the icon path, so the icon table stays inside index byte limits.
ALTER TABLE itemshare_shared_items
  ADD COLUMN IF NOT EXISTS icon_key CHAR(40) NOT NULL DEFAULT '' AFTER icon;

CREATE TABLE IF NOT EXISTS itemshare_item_icons (
  icon_key CHAR(40) NOT NULL,
  source_path VARCHAR(255) NOT NULL DEFAULT '',
  content_type VARCHAR(64) NOT NULL DEFAULT 'image/png',
  image_data MEDIUMBLOB NOT NULL,
  fetched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (icon_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
