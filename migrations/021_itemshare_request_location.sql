-- Where the owner's copy was believed to be when the request was made.
--
-- The request email has to tell the owner which container to open, and the owner is the
-- only person who can see their own bank, so the location travels with the request.
--
-- Copied rather than joined, for the same reason the trait and the icon are (013): an
-- upload prunes and rewrites item rows, and a request outlives the row it was made from.
-- A location copied at the moment of asking is also the honest one - it is where the
-- copy was when somebody was told to look, even if the owner has moved it since.
--
-- Standing offers carry no location of their own (008), so their requests keep the empty
-- default and the email simply says nothing about where.

ALTER TABLE itemshare_requests
  ADD COLUMN IF NOT EXISTS location_label VARCHAR(255) NOT NULL DEFAULT ''
  AFTER enchant_name;
