#!/usr/bin/env node
// Switching one person's sign-in off, for whoever runs the site.
//
//   ./disableSignIn.js someone@example.com              # switch it off and sign them out
//   ./disableSignIn.js someone@example.com --enable     # switch it back on
//   ./disableSignIn.js someone@example.com --dry-run     # only say what would change
//
// Nothing in the site could stop one person signing in before this: the row existed because
// they signed up, and it stayed usable for as long as they liked. The decision lives in
// `itemshare_users.disabled_at` (023), and the server asks about it once per signed-in
// request, so switching it off stops a session that was handed out earlier instead of only
// stopping the next sign-in.
//
// This script also stamps that person's sessions (lib/sessionNotice.js), so every device
// says "your sign-in was switched off" on its next page rather than dropping to the front
// page as a visitor. Switching it back on does not sign anybody in: they use the way in they
// already had, which is the point of not deleting anything.
//
// Reads the same .env as the server, from this folder.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { describeConnectionFailure, openDatabase, readConfig } from './lib/database.js';
import { emailLooksValid, normalizeEmail } from './lib/passwords.js';
import { setSignInDisabled } from './lib/store.js';
import { SIGN_IN_DISABLED, signOutOtherSessions } from './lib/sessionNotice.js';

// Read .env by absolute path, the way the server and the other CLIs do, so running this
// from anywhere finds the same credentials instead of silently using defaults.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');
const hasEnvFile = existsSync(envPath);
dotenv.config({ path: envPath });

const USAGE = `Usage: ./disableSignIn.js <address> [--enable] [--dry-run]

  <address>    Any address that person signs in with.
  --enable     Switch the sign-in back on instead of off.
  --dry-run    Look the person up and say what would change, then stop.

Switching a sign-in off ends every session that person has, and each device says why on its
next page. Switching it back on leaves those sessions ended.

Reads the same .env as the server, from this folder: MARIADB_HOST, MARIADB_PORT,
MARIADB_USER, MARIADB_PASSWORD and ITEMSHARE_DATABASE.

Exit codes: 0 changed (or a dry run), 1 nothing changed, 2 usage.`;

/**
 * The person behind an address, whichever way they sign in.
 *
 * A provider sign-in keeps the address on its identity row, not on the person, so both are
 * searched: an operator has the address they were given, and it should not matter whether it
 * arrived through the site's form or through Google.
 *
 * @returns {Promise<{found: false, address: string}
 *   | {found: true, address: string, userId: number, displayName: string,
 *      disabled: boolean, providers: string[]}>}
 */
export async function findSignIn(connection, email) {
  const address = normalizeEmail(email);

  const [rows] = await connection.execute(
    `SELECT u.id AS user_id, u.display_name, u.disabled_at,
            GROUP_CONCAT(DISTINCT i.provider ORDER BY i.provider) AS providers
       FROM itemshare_users u
       LEFT JOIN itemshare_user_identities i ON i.user_id = u.id
      WHERE u.email = ? OR i.provider_email = ?
      GROUP BY u.id, u.display_name, u.disabled_at
      ORDER BY u.id
      LIMIT 1`,
    [address, address]
  );

  const row = rows[0];

  if (!row) {
    return { found: false, address };
  }

  return {
    found: true,
    address,
    userId: Number(row.user_id),
    displayName: String(row.display_name || ''),
    disabled: Boolean(row.disabled_at),
    providers: String(row.providers || '')
      .split(',')
      .filter(Boolean),
  };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const email = args.find((arg) => !arg.startsWith('-'));
  const dryRun = args.includes('--dry-run');
  const enable = args.includes('--enable');

  if (!email) {
    console.error(USAGE);
    return 2;
  }

  if (!emailLooksValid(email)) {
    console.error(`"${email}" does not look like an email address.`);
    return 1;
  }

  const config = readConfig();

  console.log(`Env file: ${hasEnvFile ? envPath : `${envPath} not found - copy .env.example to .env`}`);
  console.log(`Database: ${config.database} at ${config.host}:${config.port} as ${config.user}`);

  let connection;

  try {
    ({ connection } = await openDatabase(config, { migrate: false }));
  } catch (error) {
    console.error(`Could not open the database: ${describeConnectionFailure(error, config)}`);
    return 1;
  }

  try {
    const signIn = await findSignIn(connection, email);

    if (!signIn.found) {
      console.error(`No sign-in for ${normalizeEmail(email)}.`);
      console.error('Nobody has signed up with that address. Check the spelling before trying again.');
      return 1;
    }

    console.log(`Person:  ${signIn.displayName || '(no display name)'} (#${signIn.userId})`);
    console.log(`Sign-in: ${signIn.providers.join(', ') || '(no provider recorded)'}`);
    console.log(`State:   ${signIn.disabled ? 'switched off' : 'on'}`);

    if (dryRun) {
      console.log(
        enable
          ? 'Dry run: would switch it back on. Nothing was changed.'
          : 'Dry run: would switch it off and end every session they have. Nothing was changed.'
      );
      return 0;
    }

    await setSignInDisabled(connection, { userId: signIn.userId, disabled: !enable });

    if (enable) {
      console.log(
        signIn.disabled ? 'Switched it back on.' : 'It was already on; nothing was changed.'
      );
      console.log('Their devices stay signed out; they sign in again the way they always did.');
      return 0;
    }

    console.log(signIn.disabled ? 'It was already switched off.' : 'Switched it off.');

    const ended = await signOutOtherSessions(connection, {
      userId: signIn.userId,
      keepSid: '',
      reason: SIGN_IN_DISABLED,
    });

    console.log(
      ended === 0
        ? 'No signed-in session was open for them.'
        : `Signed out ${ended} active session${ended === 1 ? '' : 's'}; each device is told why on its next page.`
    );
    console.log('They cannot sign in again until this is switched back on.');

    return 0;
  } finally {
    await connection.end().catch(() => {});
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error?.stack || String(error));
      process.exit(1);
    });
}
