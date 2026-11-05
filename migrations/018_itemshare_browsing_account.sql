-- Which ESO account this person browses as.
--
-- One person can own several accounts, and each sits in its own set of guilds. The
-- chosen account decides what the Request list shows, and it is the character an owner
-- is told to mail. Offering deliberately still spans every account, so a second
-- account never hides what the first one offers.
--
-- Empty means "not chosen yet"; the server reads that as the oldest linked account, so
-- every person who existed before this migration keeps behaving exactly as they did.
--
-- Stored on the person rather than in the session because it is a preference, not a
-- login: it should survive signing out and follow them to another device.

ALTER TABLE itemshare_users
  ADD COLUMN IF NOT EXISTS browsing_eso_account_name VARCHAR(96) NOT NULL DEFAULT '';
