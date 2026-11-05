-- Profile picture from the sign-in provider.
--
-- Discord gives an avatar hash, Google gives a full picture URL; both are normalised
-- into this column at sign-in so the header does not care which provider was used.
-- Initials remain the fallback when a provider has no picture, or the picture stops
-- loading, so the header never depends on a third party being reachable.

ALTER TABLE itemshare_users
  ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(512) NOT NULL DEFAULT '' AFTER email_verified;
