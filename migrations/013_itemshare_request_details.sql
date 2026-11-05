-- The picture and the trait a request was made against, kept on the request itself.
--
-- A request outlives the item row it was made from: an upload prunes and rewrites
-- those rows, and a row that moved character gets re-pointed. Looking the icon up
-- through the live row would therefore make the history lose pictures over time.
-- Copying the two fields at the moment of asking keeps the record readable forever.
--
-- icon_key is the same hash used by itemshare_shared_items, so the icon endpoint and
-- the cached image table work unchanged.

ALTER TABLE itemshare_requests
  ADD COLUMN IF NOT EXISTS icon_key CHAR(40) NOT NULL DEFAULT '' AFTER item_name;

ALTER TABLE itemshare_requests
  ADD COLUMN IF NOT EXISTS trait VARCHAR(64) NOT NULL DEFAULT '' AFTER item_type_name;
