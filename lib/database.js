// MariaDB connection handling for ItemShare. Mirrors the GuildSync backend:
// MARIADB_* connection variables, schema created on demand, plain .sql
// migrations applied in filename order.
//
// Migrations are tracked in itemshare_schema_migrations, so each file runs once.
// Adding a new .sql file to migrations/ is all that is needed for the next
// startup to apply it.
//
// A file is recorded only after every statement in it has succeeded, so one that
// fails part way - a restart mid-file, a dropped connection - is retried on the
// next startup with its earlier statements already applied. Every statement must
// therefore be safe to run again (`ADD COLUMN IF NOT EXISTS`,
// `ADD INDEX IF NOT EXISTS`); otherwise that one file fails on the duplicate it
// created itself and every later migration, including the columns the pages
// select, stays unapplied for good.

import { readdir, readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';

const DEFAULT_DATABASE = 'itemshare';
const SLOW_IDENTIFIER = /^[A-Za-z0-9_]+$/;
const LEDGER_TABLE = 'itemshare_schema_migrations';

export function readConfig(env = process.env) {
  const database = (env.ITEMSHARE_DATABASE || DEFAULT_DATABASE).trim();

  if (!SLOW_IDENTIFIER.test(database)) {
    throw new Error(
      `ITEMSHARE_DATABASE "${database}" is not a valid database name; use letters, digits and underscores`
    );
  }

  return {
    host: env.MARIADB_HOST || '127.0.0.1',
    port: Number(env.MARIADB_PORT || 3306),
    user: env.MARIADB_USER || 'root',
    password: env.MARIADB_PASSWORD || '',
    database,
  };
}

export function splitStatements(sql) {
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  return withoutComments
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function ensureLedger(connection) {
  await connection.query(
    `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
       filename VARCHAR(255) NOT NULL,
       applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (filename)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
}

/**
 * Applies every migration file that has not been recorded yet.
 * @returns {Promise<string[]>} filenames applied by this call
 */
export async function applyMigrations(connection, migrationsUrl = new URL('../migrations/', import.meta.url)) {
  const files = (await readdir(migrationsUrl)).filter((file) => file.endsWith('.sql')).sort();

  await ensureLedger(connection);

  const [rows] = await connection.query(`SELECT filename FROM ${LEDGER_TABLE}`);
  const applied = new Set(rows.map((row) => row.filename));
  const newlyApplied = [];

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }

    const sql = await readFile(new URL(file, migrationsUrl), 'utf8');

    try {
      for (const statement of splitStatements(sql)) {
        await connection.query(statement);
      }
    } catch (error) {
      // The driver's message alone (`Duplicate column name 'expires_at'`) says
      // nothing about which file or how far the schema got; startup needs both.
      throw new Error(`${file} failed: ${error.message}`, { cause: error });
    }

    await connection.query(`INSERT INTO ${LEDGER_TABLE} (filename) VALUES (?)`, [file]);
    newlyApplied.push(file);
  }

  return newlyApplied;
}

/**
 * Opens a connection. With migrate (the default) it creates the database if
 * needed and applies pending migrations; without it, it connects straight to the
 * existing database, which is what per-request connections do.
 * GuildSync keeps its own database, so nothing here reads MARIADB_DATABASE.
 */
export async function openDatabase(config, { migrate = true } = {}) {
  if (!migrate) {
    const connection = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
    });
    return { connection, migrations: [] };
  }

  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
  });

  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await connection.query(`USE \`${config.database}\``);
    const migrations = await applyMigrations(connection);
    return { connection, migrations };
  } catch (error) {
    await connection.end().catch(() => {});
    throw error;
  }
}

/**
 * Turns a startup connection failure into the command that fixes it. The case
 * that costs people the most time is an account whose authentication plugin
 * mysql2 cannot speak (usually gssapi); the driver's own message says nothing
 * about what to run.
 * @returns {string} lines to print, already joined
 */
export function describeConnectionFailure(error, config = {}) {
  const message = String((error && error.message) || error);
  const user = config.user || 'the configured user';
  const host = config.host || 'the configured host';

  if (/auth_gssapi|unknown plugin/i.test(message)) {
    return [
      `Database not ready at startup: ${message}`,
      `The account "${user}" on ${host} authenticates with a plugin mysql2 cannot use.`,
      'On the MariaDB host, as an administrator, give it an ordinary password login:',
      `  SELECT user, host, plugin FROM mysql.user WHERE user = '${user}';`,
      `  ALTER USER '${user}'@'%' IDENTIFIED VIA mysql_native_password USING PASSWORD('<the password from .env>');`,
      '  FLUSH PRIVILEGES;',
      'Then restart this server so the migrations run.',
    ].join('\n');
  }

  if (/access denied/i.test(message)) {
    return [
      `Database not ready at startup: ${message}`,
      `Check MARIADB_USER, MARIADB_PASSWORD and MARIADB_HOST for "${user}"@${host},`,
      "and that the account is allowed to connect from this machine's address.",
      'The site stays up and shows the error; fix the MariaDB settings and restart to apply migrations.',
    ].join('\n');
  }

  return [
    `Database not ready at startup: ${message}`,
    'The site stays up and shows the error; fix the MariaDB settings and restart to apply migrations.',
  ].join('\n');
}
