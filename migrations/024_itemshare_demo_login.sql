-- A sign-in that exists to be looked at.
--
-- The Demo person is a real row like any other, because everything it reads (guilds,
-- shared items, standing offers, baskets) is keyed by a person id. This column is only
-- there to find it again and to tell the server that its writes must be refused.
--
-- It is not nullable and defaults to 0, so every existing person is ordinary without
-- being touched, and the ALTER can be re-run.
ALTER TABLE itemshare_users
  ADD COLUMN IF NOT EXISTS is_demo TINYINT(1) NOT NULL DEFAULT 0;
