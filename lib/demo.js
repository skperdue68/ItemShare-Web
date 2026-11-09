// The Demo sign-in.
//
// It exists so somebody can see what the site looks like with a guild full of items
// without uploading anything or joining a guild: one person, one ESO account, one
// guild, a handful of curated items. Everything they do is refused on the server -
// this module owns the identity and the read-only rule, and server.js applies it.
//
// The account is deliberately not @DemoTrader, which seedDemo.js drops into real
// guilds: those two would otherwise overwrite each other's rows.

import { findPasswordLogin, replaceAccounts } from './store.js';
import { hashPassword } from './passwords.js';
import {
  ITEMS,
  OFFERS,
  buildItem,
  buildOffer,
} from './demoItems.js';

/** What somebody types instead of an email. Lower case, compared as typed. */
export const DEMO_LOGIN = 'demo';

/** The password. Short on purpose, and only ever hashed for this one identity. */
export const DEMO_PASSWORD = 'Demo';

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

/** The address on the demo person. `.invalid` can never be a real mailbox. */
export const DEMO_EMAIL = 'demo@itemshare.invalid';

/**
 * The database the demo lives in.
 *
 * Not a filtered view of the real one: its own copy of the same schema, so a demo
 * session can neither see nor touch a real person's rows, and the real database is not
 * opened on its behalf at all. The hyphen is legal in a quoted identifier, which is how
 * lib/database.js creates and selects it.
 */
export const DEMO_DATABASE = 'ItemShare-Demo';

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
 * Whether an action has to be refused for a demo session.
 *
 * Everything that changes something is refused - except logging out, which changes
 * only this browser. Reading is never refused: the point of the demo is to see the
 * lists, the filters, the request dialog and the owner pages.
 *
 * Kept as a plain predicate so the rule can be tested without a server: the routes it
 * covers are the ones that write (accounts, uploads, baskets, requests, answers).
 */
export function demoRefusal(method, path) {
  if (String(method || '').toUpperCase() !== 'POST') {
    return false;
  }

  const route = String(path || '');

  if (route === '/logout') {
    return false;
  }

  return (
    route.startsWith('/accounts/') ||
    route === '/upload' ||
    route === '/browsing-account' ||
    route.startsWith('/requests') ||
    route === '/owner/requests' ||
    route.startsWith('/simulate')
  );
}

/**
 * Makes the demo person, its ESO account and its items exist, once.
 *
 * Called at boot and again when somebody signs in as Demo, so a database that was
 * restored, or one where the demo rows were removed, heals itself. The write only
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

  return { userId, created, seeded };
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
