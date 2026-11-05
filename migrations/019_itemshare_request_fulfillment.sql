-- Handing a request over: what was actually mailed, and the one-time form in the email.
--
-- `quantity` is what is still outstanding, and every free/reserved calculation sums
-- it, so it must keep meaning that. A handover sets it to the number that arrived,
-- because nothing is outstanding any more; `quantity_requested` keeps the ask as it
-- was made, so a partial delivery still reads "4 of 10" instead of pretending ten
-- arrived.
--
-- `fulfilled_at` is when the owner answered. Availability subtracts delivered copies
-- only until the owner's next upload has had a chance to leave them out, which is
-- what stops one handover being taken off the count twice - an error that would lose
-- stock permanently, because the file's own total is the truth afterwards.
--
-- `email_token_hash` is SHA-256 of the token in the link, never the token itself: the
-- message is the only copy of it. One token covers every row of one email, answering
-- clears it, and it expires, so a double submit, a resent mail or a link a mail client
-- prefetched changes nothing the second time.

ALTER TABLE itemshare_requests
  ADD COLUMN IF NOT EXISTS quantity_requested INT NOT NULL DEFAULT 0 AFTER quantity,
  ADD COLUMN IF NOT EXISTS fulfilled_at TIMESTAMP NULL DEFAULT NULL AFTER expires_at,
  ADD COLUMN IF NOT EXISTS email_token_hash CHAR(64) NOT NULL DEFAULT '' AFTER fulfilled_at,
  ADD COLUMN IF NOT EXISTS email_token_expires_at DATETIME NULL DEFAULT NULL AFTER email_token_hash;

-- Rows sent before this migration were asked for once and, since nothing could
-- answer them, are still outstanding in full.
UPDATE itemshare_requests
   SET quantity_requested = quantity
 WHERE quantity_requested = 0;

ALTER TABLE itemshare_requests
  ADD KEY idx_itemshare_requests_token (email_token_hash);

-- The delivered/count query filters on these two.
ALTER TABLE itemshare_requests
  ADD KEY idx_itemshare_requests_delivered (status, fulfilled_at);
