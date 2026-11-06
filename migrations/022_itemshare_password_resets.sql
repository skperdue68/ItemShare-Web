-- Password reset links, for somebody who cannot get back in.
--
-- The token in the mail is never stored: `token_hash` is its SHA-256, so a copy of this
-- table cannot be turned back into working links. Asking again deletes the earlier links
-- for that person, and using one marks every link for them used - so a second message
-- still sitting in an inbox is not another way in after the password has been chosen.

CREATE TABLE IF NOT EXISTS itemshare_password_resets (
  token_hash CHAR(64) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  used_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (token_hash),
  KEY idx_itemshare_password_resets_user (user_id),
  KEY idx_itemshare_password_resets_expiry (expires_at),
  CONSTRAINT fk_itemshare_password_resets_user
    FOREIGN KEY (user_id) REFERENCES itemshare_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
