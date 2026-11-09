-- The crafting style, level and champion points a request was made against, kept on
-- the request itself.
--
-- The owner answering a request is the one person who has to identify the copy, and two
-- daggers of the same name, quality, trait and enchantment differ only by these three.
-- The trait and the enchantment already travel on the request (013, 015) because the
-- live item row is pruned and rewritten by the next upload; the same reasoning applies
-- here, and it also lets a standing offer name them, since an offer carries no live
-- inventory row to look them up through.
--
-- Zero and the empty string are the honest values for the rows that came before this:
-- a request made when the addon did not record these pieces has nothing to say about
-- them, and the detail line drops both.

ALTER TABLE itemshare_requests
  ADD COLUMN IF NOT EXISTS style_name VARCHAR(128) NOT NULL DEFAULT '' AFTER enchant_name;

ALTER TABLE itemshare_requests
  ADD COLUMN IF NOT EXISTS required_level INT NOT NULL DEFAULT 0 AFTER style_name;

ALTER TABLE itemshare_requests
  ADD COLUMN IF NOT EXISTS required_cp INT NOT NULL DEFAULT 0 AFTER required_level;
