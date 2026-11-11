-- A standing offer can now tell "the owner holds none" from "the file never said".
--
-- `held_quantity` was NOT NULL DEFAULT 0, which made an older addon build that writes no
-- `heldCount` indistinguishable from a file that reports 0: the offer read as one copy
-- either way, so an owner who had emptied their bags still showed one on offer.
--
-- The column is nullable now. Null means the file said nothing - the offer keeps the one
-- copy it has always meant - and a number the file did write, zero included, is the
-- answer. Existing rows are left alone rather than backfilled: a 0 already stored may be
-- either meaning, and the next upload of that account writes the truth, because every
-- always-share row is refreshed from the file on every upload.
ALTER TABLE itemshare_always_share
  MODIFY COLUMN held_quantity INT NULL DEFAULT NULL;
