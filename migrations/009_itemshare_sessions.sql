-- Sign-in sessions, so being signed in survives a restart.
--
-- express-session's MemoryStore keeps sessions in the process, so every restart
-- (a deploy, a crash, a reboot) signed everyone out even though their cookie was
-- still valid. These rows make the session outlive the process, and are removed
-- when someone chooses Log out or when the cookie expires.
--
-- expires_at is Unix seconds rather than DATETIME on purpose: the Node process and
-- MariaDB need not agree on a timezone, and comparing integers cannot drift.

CREATE TABLE IF NOT EXISTS itemshare_sessions (
  sid VARCHAR(128) NOT NULL,
  session_data MEDIUMTEXT NOT NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (sid),
  KEY idx_itemshare_sessions_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
