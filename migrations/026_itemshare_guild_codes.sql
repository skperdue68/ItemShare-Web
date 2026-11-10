-- A member of a guild can hand out a code that lets somebody else in.
--
-- The code names one guild on one server, because that is what a guild is here: the same
-- numeric id on NA and EU, or on PC and Xbox, is a different guild.
--
-- Redeeming one is not an upload: the person may be in none of that guild's guilds in
-- game, but they have been invited, so the membership is recorded on the ESO account they
-- browse as and marked with the code it came from. `granted_code_id` is what tells the
-- next upload to leave that row alone - an upload replaces the memberships the game
-- reported, and it would otherwise erase an invitation on the first file the person sends.
--
-- NULL means "the game said so". A code lives until the site's owner removes it; the row
-- of redemptions is what tells one code from another afterwards.

CREATE TABLE IF NOT EXISTS itemshare_guild_codes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- Eight characters, no I, L, O, 0 or 1, shown as two groups of four.
  code VARCHAR(24) NOT NULL,
  guild_id BIGINT UNSIGNED NOT NULL,
  guild_name VARCHAR(255) NOT NULL DEFAULT '',
  platform SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  world_name VARCHAR(64) NOT NULL DEFAULT '',
  created_by_user_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_itemshare_guild_codes_code (code),
  KEY idx_itemshare_guild_codes_creator (created_by_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS itemshare_guild_code_redemptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  -- The account the membership was written to, for the record.
  account_name VARCHAR(96) NOT NULL DEFAULT '',
  redeemed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_itemshare_guild_code_redemption (code_id, user_id),
  KEY idx_itemshare_guild_code_redemptions_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which memberships came from a code, and which from the game.
ALTER TABLE itemshare_account_guilds
  ADD COLUMN IF NOT EXISTS granted_code_id BIGINT UNSIGNED NULL DEFAULT NULL,
  ADD KEY idx_itemshare_account_guilds_granted (granted_code_id);
