-- Item detail captured straight from the game client at share time.
--
-- The addon (1.5.0+) probes every item getter the running API exposes and keeps
-- the scalar results on each shared item. The columns below promote the handful
-- the site can display today; eso_data keeps every raw result, so detail this
-- version does not render yet is still stored and can be used later without a
-- second in-game capture. UESP enrichment therefore only ever fills gaps the
-- client left empty.

ALTER TABLE itemshare_shared_items
  ADD COLUMN IF NOT EXISTS set_name VARCHAR(255) NOT NULL DEFAULT '' AFTER weapon_handedness;

ALTER TABLE itemshare_shared_items
  ADD COLUMN IF NOT EXISTS enchant_name VARCHAR(255) NOT NULL DEFAULT '' AFTER set_name;

ALTER TABLE itemshare_shared_items
  ADD COLUMN IF NOT EXISTS style_name VARCHAR(128) NOT NULL DEFAULT '' AFTER enchant_name;

ALTER TABLE itemshare_shared_items
  ADD COLUMN IF NOT EXISTS required_level INT NOT NULL DEFAULT 0 AFTER style_name;

ALTER TABLE itemshare_shared_items
  ADD COLUMN IF NOT EXISTS required_cp INT NOT NULL DEFAULT 0 AFTER required_level;

ALTER TABLE itemshare_shared_items
  ADD COLUMN IF NOT EXISTS flavor_text TEXT NULL AFTER required_cp;

-- One entry per getter that answered, e.g.
-- {"GetItemLinkSetInfo":[true,"Briarheart",5,3,5],"GetItemLinkFlavorText":["..."]}
ALTER TABLE itemshare_shared_items
  ADD COLUMN IF NOT EXISTS eso_data JSON NULL AFTER flavor_text;
