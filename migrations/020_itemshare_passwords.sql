-- Email and password sign-in.
--
-- The site used to have only Discord and Google, so somebody with neither of those
-- could not sign in, and the site could not tell them apart from a stranger. The
-- password lives in its own table, one per person; the address is an identity row
-- ('password', the normalised address), the same shape as an OAuth identity, so the
-- rest of the code does not have to know which way somebody signed in.
--
-- No address from this route is ever marked verified. An address typed into a form is
-- only what the person says it is, so it must not be allowed to join an existing
-- person the way a verified provider address does (see signInWithProvider).
--
-- The hash is one string in the form scrypt$N$r$p$salt$hash, so the parameters that
-- made it travel with it and a future change of cost cannot invalidate older rows.

CREATE TABLE IF NOT EXISTS itemshare_passwords (
  user_id BIGINT UNSIGNED NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_itemshare_passwords_user
    FOREIGN KEY (user_id) REFERENCES itemshare_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
