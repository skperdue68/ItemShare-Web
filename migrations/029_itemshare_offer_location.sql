-- A standing offer can now say where it is offered from.
--
-- 008 left this table without a location on purpose: an offer was a promise rather than a
-- copy sitting in a bag, so there was no place to name. The addon build that records the
-- count of a standing offer records the place it was marked in with it (`sharedFrom` and
-- `locationKey`), which is the one place the offer's number belongs to, so the site can
-- show it beside the other columns on My Inventory.
--
-- A file from an older addon writes neither, so both columns stay empty and the row draws
-- a dash - the same thing it drew before this existed. Nothing is inferred: an empty
-- location means the file did not say, not that the owner keeps it nowhere.
ALTER TABLE itemshare_always_share
  ADD COLUMN IF NOT EXISTS location_key VARCHAR(191) NOT NULL DEFAULT '' AFTER furniture_data_id,
  ADD COLUMN IF NOT EXISTS location_label VARCHAR(255) NOT NULL DEFAULT '' AFTER location_key;
