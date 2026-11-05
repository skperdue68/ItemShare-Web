-- What an item's hover card shows beyond the addon's own fields: the game's
-- description and what the item's set does.
--
-- The answers come from UESP's public item database, which is somebody else's
-- server: one row per card here means a name is looked up once a month however many
-- times it is hovered, and the page never waits on a slow lookup twice.
--
-- payload holds the whole normalised answer, so the shape can gain fields without a
-- migration. A missing row just means "not looked up yet".

CREATE TABLE IF NOT EXISTS itemshare_item_tips (
  tip_key VARCHAR(191) NOT NULL,
  payload JSON NOT NULL,
  fetched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tip_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
