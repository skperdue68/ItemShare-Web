-- What the owner keeps back, and how much they were holding when they said so.
--
-- The quantity the site lists has always been the shareable number: the addon
-- subtracts the reserve before it uploads, so `item_count` is what is really on
-- offer. That is the number every free/held calculation uses and it must not change.
-- These two columns are the explanation beside it, so a row that offers 8 of 20 can
-- say so instead of looking like the owner only ever had 8.
--
-- They are additive and default to 0, which is exactly what every row written before
-- this migration means: no reserve, so everything held is shareable.

ALTER TABLE itemshare_shared_items
  ADD COLUMN IF NOT EXISTS held_quantity INT NOT NULL DEFAULT 0 AFTER item_count,
  ADD COLUMN IF NOT EXISTS reserve_quantity INT NOT NULL DEFAULT 0 AFTER held_quantity;

ALTER TABLE itemshare_always_share
  ADD COLUMN IF NOT EXISTS held_quantity INT NOT NULL DEFAULT 0 AFTER furniture_data_id,
  ADD COLUMN IF NOT EXISTS reserve_quantity INT NOT NULL DEFAULT 0 AFTER held_quantity;
