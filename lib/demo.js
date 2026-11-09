// The Demo sign-in.
//
// It exists so somebody can see what the site looks like with a guild full of items
// without uploading anything or joining a guild. It runs in its own copy of the
// database, filled from the real one, so everything a visitor does there - reserving,
// cancelling, sending a basket, answering a request, adding an account - really
// happens. What cannot happen is anything that would leave the copy: no email, no
// uploaded file, no password reset link.
//
// The account is deliberately not @DemoTrader, which seedDemo.js drops into real
// guilds: those two would otherwise overwrite each other's rows.

import { findPasswordLogin, replaceAccounts } from './store.js';
import { ensureDemoCast } from './demoCast.js';
import { hashPassword } from './passwords.js';
import {
  ITEMS,
  OFFERS,
  buildItem,
  buildOffer,
} from './demoItems.js';

/**
 * The address the demo signs in with.
 *
 * A real address shape on the reserved documentation domain, so the demo is used like
 * any other account - typed into the email box, with a password - rather than needing a
 * magic word there. Nothing is ever delivered to it.
 */
export const DEMO_LOGIN = 'demo@example.com';

/** The password. Short and lower case on purpose, and hashed for this identity only. */
export const DEMO_PASSWORD = 'demo';

export const DEMO_DISPLAY_NAME = 'Demo';

/**
 * The world the demo guild lives on, named the way the addon names it. It matches the
 * shape of a real world so the server-aware matching in lib/store.js applies unchanged.
 */
export const DEMO_WORLD = { platform: 2, worldName: 'NA Megaserver' };

/** One guild, with an id no real guild can have, so the demo cannot join somebody else's. */
export const DEMO_GUILD = { id: 9900001, name: 'Alphabet Mafia' };

/** The ESO account the demo items are shared from. */
export const DEMO_ACCOUNT = '@ItemShareDemo';

/** The address on the demo person: the same one that signs in, so the row is coherent. */
export const DEMO_EMAIL = 'demo@example.com';

/**
 * The database the demo lives in.
 *
 * Not a filtered view of the real one: its own copy of the same schema, so a demo
 * session can neither see nor touch a real person's rows, and the real database is not
 * opened on its behalf at all. It is dropped and rebuilt from the migrations on every
 * startup, so its schema can never drift from the real one's and the next visitor always
 * gets the curated demo rather than the leftovers of somebody's session. The hyphen is
 * legal in a quoted identifier, which is how lib/database.js creates and selects it.
 */
export const DEMO_DATABASE = 'itemshare-demo';

/**
 * The connection settings for the demo database: the site's own, with the name swapped.
 *
 * Refuses to hand back the site database, because the demo copy is dropped and rebuilt
 * at startup and that must never happen to the real rows.
 */
export function demoDatabaseConfig(config) {
  const site = String((config && config.database) || '').toLowerCase();

  if (!site || site === DEMO_DATABASE.toLowerCase()) {
    throw new Error(
      `The demo database (${DEMO_DATABASE}) must be a different database from the site's (${site || 'unset'})`
    );
  }

  return { ...config, database: DEMO_DATABASE };
}

const SAFE_DATABASE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Tables the demo copy never takes: its own sessions (a copied one would be a live
 * login), and its own migration ledger (which must stay the demo database's record).
 */
const NEVER_COPIED = new Set(['itemshare_sessions', 'itemshare_schema_migrations']);

function quoteDatabase(name, label) {
  const text = String(name || '');

  if (!SAFE_DATABASE_NAME.test(text)) {
    throw new Error(`${label} "${text}" is not a valid database name`);
  }

  return `\`${text}\``;
}

/**
 * Fills the freshly rebuilt demo copy with the site's own rows.
 *
 * Without this the demo would hold only the curated guild and could not show what a
 * real site looks like: several guilds, many owners, items that are partly reserved,
 * requests already in flight. The rows are copied table by table with their ids, so
 * the links between them survive, and then the people are anonymised - a visitor with
 * no account must not be able to read anybody's name, address or credentials, and a
 * copied password must not sign in as anybody.
 *
 * Runs only against the demo database, whose rows are about to be thrown away at the
 * next start anyway.
 *
 * @returns {Promise<{copied: number, failed: {table: string, error: string}[]}>}
 */
export async function copyDemoData(
  connection,
  { sourceDatabase, demoDatabase = DEMO_DATABASE } = {}
) {
  const source = quoteDatabase(sourceDatabase, 'The site database');
  const demo = quoteDatabase(demoDatabase, 'The demo database');

  const [tableRows] = await connection.query(`SHOW TABLES FROM ${source}`);
  const tables = tableRows
    .map((row) => String(Object.values(row)[0] || ''))
    .filter((table) => table && !NEVER_COPIED.has(table));

  if (tables.length === 0) {
    return { copied: 0, failed: [] };
  }

  // Rows keep their ids, so a request still points at its item; the order the tables
  // arrive in is not the order their foreign keys want, so the checks are off.
  await connection.query('SET SESSION FOREIGN_KEY_CHECKS = 0');

  const failed = [];

  try {
    for (const table of tables) {
      try {
        await connection.query(
          `INSERT INTO ${demo}.\`${table}\` SELECT * FROM ${source}.\`${table}\``
        );
      } catch (error) {
        // One unreadable table must not cost the whole demo; the rest still copies and
        // the caller logs what failed.
        failed.push({ table, error: error.message });
      }
    }
  } finally {
    await connection.query('SET SESSION FOREIGN_KEY_CHECKS = 1');
  }

  // Who people are is not part of what the demo teaches. Names and addresses become
  // placeholders, and the credentials go entirely: an emptied password table plus
  // emptied identities means no copied row can be signed into.
  await connection.query(
    `UPDATE ${demo}.itemshare_users
        SET display_name = CONCAT('Member ', id),
            email = CONCAT('member', id, '@itemshare.invalid'),
            email_verified = 0`
  );
  await connection.query(`DELETE FROM ${demo}.itemshare_passwords`);
  await connection.query(`DELETE FROM ${demo}.itemshare_user_identities`);

  return { copied: tables.length - failed.length, failed };
}

/**
 * Which database a request belongs in, or null for the ordinary one.
 *
 * Kept here, next to the name of the demo database, so the one rule that decides where
 * a request reads and writes can be tested without a server or a MariaDB.
 */
export function databaseForUser(user) {
  return user && user.isDemo ? DEMO_DATABASE : null;
}

/**
 * The little a demo session still may not do.
 *
 * Almost everything is a rehearsal rather than a refusal: the demo runs in its own
 * database, so reserving, cancelling, sending a basket, answering a request and
 * changing accounts all really happen - inside the copy, where nobody else can see
 * them. What has to be stopped is anything that would leave the copy:
 *
 *   /upload                  a real file would replace the demo shelf with somebody's
 *                            own inventory, and the copy is built for a walkthrough
 *   /auth/email/forgot       a reset link is an email, and the demo never sends one
 *   /auth/email/reset/:tok   the same, from the other end of the reset
 *   /simulate                it would tell every open page on the site what the demo did
 *
 * Kept as a plain predicate so the rule can be tested without a server.
 */
export function demoRefusal(method, path) {
  if (String(method || '').toUpperCase() !== 'POST') {
    return false;
  }

  const route = String(path || '');

  return (
    route === '/upload' ||
    route.startsWith('/simulate') ||
    route.startsWith('/auth/email/forgot') ||
    route.startsWith('/auth/email/reset')
  );
}

/** The sentence that explains a refusal, chosen by the route that was refused. */
export function demoRefusalMessage(path) {
  const route = String(path || '');

  if (route === '/upload') {
    return 'Uploading is switched off on a demo account: the demo already has a guild of items, and a file would replace them. Sign in as a non-demo user to upload your own saved variables.';
  }

  if (route.startsWith('/auth/email')) {
    return 'The demo never sends email, so a password reset link cannot be sent. The demo password is always demo.';
  }

  return 'That is not available in the demo.';
}

/**
 * Makes the demo person, its ESO account and its items exist, once.
 *
 * Called at boot, after the demo database has been rebuilt, and again when somebody
 * signs in as Demo, so a database that was restored, or one where the demo rows were
 * removed, heals itself. The write only
 * happens while the demo account has no shared items: a page load must not rewrite
 * rows that are already there.
 *
 * @returns {Promise<{userId: number, created: boolean, seeded: boolean}>}
 */
export async function ensureDemoData(connection) {
  const [existing] = await connection.execute(
    'SELECT id FROM itemshare_users WHERE is_demo = 1 ORDER BY id ASC LIMIT 1'
  );

  let userId = existing && existing[0] ? Number(existing[0].id) : 0;
  let created = false;

  if (!userId) {
    // 'Demo' is shorter than the sign-up form's minimum, so the hash is made with the
    // short-password allowance that exists for this one identity.
    const passwordHash = await hashPassword(DEMO_PASSWORD, { allowShort: true });

    const [inserted] = await connection.execute(
      `INSERT INTO itemshare_users (display_name, email, email_verified, is_demo)
       VALUES (?, ?, 0, 1)`,
      [DEMO_DISPLAY_NAME, DEMO_EMAIL]
    );

    userId = Number(inserted.insertId);
    created = true;

    await connection.execute(
      `INSERT INTO itemshare_user_identities
         (provider, provider_user_id, user_id, provider_username, provider_email, email_verified)
       VALUES ('password', ?, ?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
      [DEMO_LOGIN, userId, DEMO_DISPLAY_NAME, DEMO_EMAIL]
    );

    await connection.execute(
      `INSERT INTO itemshare_passwords (user_id, password_hash) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
      [userId, passwordHash]
    );
  }

  const [counted] = await connection.execute(
    'SELECT COUNT(*) AS n FROM itemshare_shared_items WHERE account_name = ?',
    [DEMO_ACCOUNT]
  );

  const shared = Number(counted && counted[0] ? counted[0].n : 0);
  let seeded = false;

  if (shared === 0) {
    const guilds = new Map([[DEMO_GUILD.id, DEMO_GUILD.name]]);

    // The same call an upload uses, so the demo account is linked to the demo person,
    // the guild is written with its world, and every item carries the guild it is
    // offered to.
    await replaceAccounts(
      connection,
      [
        {
          accountName: DEMO_ACCOUNT,
          items: ITEMS.map((spec, index) =>
            buildItem(spec, index, [DEMO_GUILD.id], { accountName: DEMO_ACCOUNT })
          ),
          alwaysShare: OFFERS.map((spec, index) =>
            buildOffer(spec, index, [DEMO_GUILD.id], { accountName: DEMO_ACCOUNT })
          ),
          guilds,
          addonVersion: 'demo',
          platform: DEMO_WORLD.platform,
          worldName: DEMO_WORLD.worldName,
        },
      ],
      { sourceFile: 'Demo sign-in', userId }
    );

    seeded = true;
  }

  // The demo's guildmates: without them the visitor owns every row they can see, so the
  // Request tab can only mirror their own bag and there is nobody to ask or answer. They
  // are written into the same guild, so their items and the demo's are visible to each
  // other, and they heal here too when the demo person already exists.
  const cast = await ensureDemoCast(connection, {
    guildId: DEMO_GUILD.id,
    guildName: DEMO_GUILD.name,
    platform: DEMO_WORLD.platform,
    worldName: DEMO_WORLD.worldName,
    source: 'Demo sign-in',
  });

  return { userId, created, seeded, cast };
}

/**
 * The demo person as a sign-in, or null when the identity is missing.
 *
 * It reads the same row an email sign-in reads, because the demo is deliberately one
 * of those: a password identity, verified the same way, with `isDemo` set so the rest
 * of the server can tell it apart.
 *
 * @returns {Promise<{userId: number, displayName: string, email: string,
 *   passwordHash: string, isDemo: boolean}|null>}
 */
export async function findDemoSignIn(connection) {
  const login = await findPasswordLogin(connection, DEMO_LOGIN);

  return login ? { ...login, isDemo: true } : null;
}
