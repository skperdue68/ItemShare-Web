-- Requests that have not been sent yet.
--
-- Until now a row in itemshare_requests was always a finished ask: it existed, so
-- it held stock. That makes the "basket" impossible to express - someone picking
-- two items out of five should not look like a promise to the owner, and walking
-- away from the page should not hold the stack forever.
--
-- So a request now starts life as a `draft` with a deadline of its own, and only
-- becomes `pending` when the person sends it. Drafts hold stock exactly like a
-- pending request does, which is what stops two people being offered the same
-- copy, but they stop holding it when expires_at passes - whether or not anyone is
-- still looking at the page, because the server sweeps them on a timer.
--
-- The deadline is per person, not per row: adding or removing anything in the
-- basket pushes every one of that person's drafts to the same new time, so the
-- countdown on screen is one number instead of one per row.

ALTER TABLE itemshare_requests
  ADD COLUMN expires_at DATETIME NULL DEFAULT NULL AFTER status,
  ADD COLUMN submitted_at DATETIME NULL DEFAULT NULL AFTER expires_at;

-- 'draft' is the new first state, 'expired' is why a draft died. Rows written
-- before this migration keep their status; nothing is rewritten here.
ALTER TABLE itemshare_requests
  MODIFY COLUMN status ENUM(
    'draft', 'pending', 'cancelled', 'fulfilled', 'declined', 'expired'
  ) NOT NULL DEFAULT 'draft';

-- The sweeper's query is `status = 'draft' AND expires_at <= NOW()`, and the
-- reserving queries all filter on the same pair.
ALTER TABLE itemshare_requests
  ADD KEY idx_itemshare_requests_expiry (status, expires_at);
