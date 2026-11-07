-- Request history: every request that was actually sent, with the moment it was sent.
--
-- `submitted_at` was added by migration 012 as a plain DATETIME, and history was
-- defined as "submitted_at IS NOT NULL". A request written as `pending` by an older
-- version, or one that reached `pending` by any path that did not set the column,
-- therefore disappeared from the requester's list: the row was still in the table,
-- but the page never showed it. The history query no longer depends on the column
-- alone, and this backfill gives those rows the moment they were created so the
-- "Sent" column has something true to show.
--
-- The column is written as UTC from now on (`UTC_TIMESTAMP()` in submitDrafts), and
-- the site sends that value to the browser as a UTC ISO stamp, which is displayed in
-- the reader's own time zone. Rows backfilled here inherit `created_at`, which is a
-- TIMESTAMP (already stored in UTC, though MariaDB returns it in the session time
-- zone), so a legacy row can be off by the host's offset; new rows cannot.
--
-- The history query reads one person's sent requests newest first, which is exactly
-- what this index covers.

UPDATE itemshare_requests
   SET submitted_at = created_at
 WHERE submitted_at IS NULL
   AND status IN ('pending', 'fulfilled', 'declined', 'expired');

-- IF NOT EXISTS keeps a retried migration from stopping on the index it already built.
ALTER TABLE itemshare_requests
  ADD INDEX IF NOT EXISTS idx_itemshare_requests_submitted (requester_user_id, submitted_at);
