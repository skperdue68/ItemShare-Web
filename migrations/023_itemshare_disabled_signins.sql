-- A sign-in the person who runs the site has switched off.
--
-- Nothing in the site could stop one person signing in before this: a row exists because
-- they signed up, and it stayed usable for as long as they liked. Switching one off needs
-- somewhere to record the decision, and the person's own row is the only place that is
-- always read - there is no second table to join, and a NULL here is the ordinary case for
-- everybody else, so the column costs nothing until it is used.
--
-- The timestamp rather than a boolean: an operator reading the row learns when it happened,
-- which is the question actually asked, and the same NULL/not-NULL test answers "is it off".
--
-- Sessions are not stored here. Switching a sign-in off stamps that person's session rows
-- with a note (lib/sessionNotice.js) instead of only editing this row, because a cookie
-- handed out before the decision must stop working on its next request.

ALTER TABLE itemshare_users
  ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMP NULL DEFAULT NULL
  AFTER email_verified;
