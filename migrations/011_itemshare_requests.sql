-- Requests: someone asking the owner of an item for a number of copies.
--
-- A request is a reservation, not a delivery. It holds part of a stack until the
-- owner hands it over or until the item is gone, and it is what makes "3 of 5
-- already asked for" answerable.
--
-- Nothing here is a foreign key on purpose. Item rows are rewritten by every
-- upload, and a cascade would erase the record of what was asked for instead of
-- leaving a cancellation the requester can read. The row ids are kept as plain
-- numbers, and the store re-points or cancels a request when they move.
--
-- status_reason is shown to the person who asked, so it is written as a sentence:
-- "Ghost Bane is no longer sharing Briarheart Dagger."

CREATE TABLE IF NOT EXISTS itemshare_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  requester_user_id BIGINT UNSIGNED NOT NULL,
  -- The requester's own ESO account, preferring the one that shares a guild with
  -- the owner: that is the character the handover would happen on.
  requester_account_name VARCHAR(96) NOT NULL DEFAULT '',
  owner_account_name VARCHAR(96) NOT NULL,
  item_kind ENUM('inventory', 'offer') NOT NULL DEFAULT 'inventory',
  -- One of these is set: the bag copy, or the standing offer it was asked from.
  shared_item_id BIGINT UNSIGNED NULL DEFAULT NULL,
  always_share_id BIGINT UNSIGNED NULL DEFAULT NULL,
  -- Kept so a request can follow its item when the row id changes.
  item_key_hash CHAR(40) NOT NULL DEFAULT '',
  item_name VARCHAR(255) NOT NULL DEFAULT '',
  item_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  quality INT NOT NULL DEFAULT 0,
  item_type_name VARCHAR(64) NOT NULL DEFAULT '',
  quantity INT NOT NULL DEFAULT 1,
  status ENUM('pending', 'cancelled', 'fulfilled', 'declined') NOT NULL DEFAULT 'pending',
  status_reason VARCHAR(255) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  closed_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_itemshare_requests_owner (owner_account_name, item_kind, status),
  KEY idx_itemshare_requests_requester (requester_user_id, status),
  KEY idx_itemshare_requests_item (shared_item_id),
  KEY idx_itemshare_requests_offer (always_share_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
