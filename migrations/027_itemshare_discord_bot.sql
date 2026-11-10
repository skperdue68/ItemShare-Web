CREATE TABLE IF NOT EXISTS itemshare_discord_associations (
 installation_id VARCHAR(96) NOT NULL,
 discord_id VARCHAR(32) NOT NULL,
 eso_account VARCHAR(96) NOT NULL,
 status ENUM('provisional','approved','rejected') NOT NULL DEFAULT 'provisional',
 selected TINYINT NOT NULL DEFAULT 0,
 reviewed_by VARCHAR(32) NULL,
 reviewed_at DATETIME NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY (installation_id, discord_id, eso_account)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS itemshare_discord_interactions (
 installation_id VARCHAR(96) NOT NULL,
 interaction_id VARCHAR(96) NOT NULL,
 discord_id VARCHAR(32) NOT NULL,
 body_hash CHAR(64) NOT NULL,
 request_id BIGINT UNSIGNED NULL,
 response_json LONGTEXT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY (installation_id, interaction_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
