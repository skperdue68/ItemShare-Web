-- The server an account plays on, now that the addon writes it.
--
-- A guild id and an @handle are only unique within one megaserver. The same numeric
-- guild id exists on NA, EU and PTS - and on PC, Xbox and PlayStation - and those are
-- different guilds. The addon now writes `worldName` and `platformRaw` into each
-- account's scope, so both are stored beside every account, guild and guild link and
-- become part of a guild's identity.
--
-- 0 and '' mean "not known": a file from an addon older than the one that writes the
-- world, or a name typed into the site by hand. Unknown is deliberately not a world of
-- its own - it matches whatever it is compared with - so everything recorded before this
-- migration keeps being visible until the next upload says where it came from.
--
-- The primary keys keep the id first, so `guild_id = ?` still uses the key it always did.

ALTER TABLE itemshare_accounts
  ADD COLUMN IF NOT EXISTS platform SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS world_name VARCHAR(64) NOT NULL DEFAULT '';

ALTER TABLE itemshare_guilds
  ADD COLUMN IF NOT EXISTS platform SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS world_name VARCHAR(64) NOT NULL DEFAULT '',
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (guild_id, platform, world_name);

ALTER TABLE itemshare_account_guilds
  ADD COLUMN IF NOT EXISTS platform SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS world_name VARCHAR(64) NOT NULL DEFAULT '',
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (account_name, guild_id, platform, world_name);

ALTER TABLE itemshare_shared_item_guilds
  ADD COLUMN IF NOT EXISTS platform SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS world_name VARCHAR(64) NOT NULL DEFAULT '',
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (item_id, guild_id, platform, world_name);

ALTER TABLE itemshare_always_share_guilds
  ADD COLUMN IF NOT EXISTS platform SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS world_name VARCHAR(64) NOT NULL DEFAULT '',
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (always_share_id, guild_id, platform, world_name);
