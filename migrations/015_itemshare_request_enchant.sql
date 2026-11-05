-- The enchantment a request was made against, kept on the request itself.
--
-- The owner's email has to say which copy was asked for: two Briarheart swords with
-- different traits, or the same ring with a different enchantment, are the same name
-- and the same set, so the detail line is what tells them apart. Copies are pruned
-- and rewritten by the next upload, so the trait and enchantment travel on the
-- request instead of being looked up through the live row.
--
-- trait already exists (migration 013); this adds the other half of the detail line.

ALTER TABLE itemshare_requests
  ADD COLUMN IF NOT EXISTS enchant_name VARCHAR(255) NOT NULL DEFAULT '' AFTER trait;
