#!/usr/bin/env node
// Password reset for an email and password sign-in, run on the server that holds the
// database.
//
//   ./resetPassword.js someone@example.com             # asks for the new password twice
//   ./resetPassword.js someone@example.com --dry-run    # only says who would change
//   printf '%s\n' "$NEW" | ./resetPassword.js someone@example.com
//
// The address is the identity (`provider = 'password'`), which is what the sign-in form
// looks up, so the reset needs nothing but the address. The new password is stored with
// the same function the sign-up form uses (`lib/passwords.js`): one row in
// `itemshare_passwords`, scrypt with a per-password salt and the cost inside the string.
// Nothing about the stored format changes, and no password is ever printed or logged.
//
// Sessions already signed in are left alone: the site keeps them in the session store,
// so resetting a password does not sign anybody out.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { describeConnectionFailure, openDatabase, readConfig } from './lib/database.js';
import { emailLooksValid, hashPassword, normalizeEmail } from './lib/passwords.js';

// Read .env by absolute path, the way the server and the other CLIs do, so running this
// from anywhere finds the same credentials instead of silently using defaults.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');
const hasEnvFile = existsSync(envPath);
dotenv.config({ path: envPath });

const USAGE = `Usage: ./resetPassword.js <address> [--dry-run]

  <address>    The email address of the password sign-in to reset.
  --dry-run    Look the person up and say what would change, then stop.

The password is typed twice without being echoed. In a script, pipe it in instead:

  printf '%s\\n' "$NEW_PASSWORD" | ./resetPassword.js someone@example.com

Reads the same .env as the server, from this folder: MARIADB_HOST, MARIADB_PORT,
MARIADB_USER, MARIADB_PASSWORD and ITEMSHARE_DATABASE.

Exit codes: 0 changed (or a dry run), 1 nothing changed, 2 usage.`;

/**
 * The person behind an email and password sign-in, and what a reset would touch.
 *
 * @returns {Promise<{found: false, address: string, otherProviders: string[]}
 *   | {found: true, address: string, userId: number, displayName: string,
 *      hasPassword: boolean, accounts: string[]}>}
 */
export async function findPasswordAccount(connection, email) {
  const address = normalizeEmail(email);
  const [rows] = await connection.execute(
    `SELECT u.id AS user_id, u.display_name, u.email,
            p.password_hash IS NOT NULL AS has_password
       FROM itemshare_user_identities i
       JOIN itemshare_users u ON u.id = i.user_id
       LEFT JOIN itemshare_passwords p ON p.user_id = u.id
      WHERE i.provider = 'password' AND i.provider_user_id = ?
      LIMIT 1`,
    [address]
  );

  const row = rows[0];

  if (!row) {
    // An address can be known to the site without a password: Discord and Google keep
    // the password themselves, so there is nothing here to reset and saying which
    // provider it is answers the question the operator actually has.
    const [others] = await connection.execute(
      `SELECT DISTINCT provider FROM itemshare_user_identities
        WHERE provider_email = ? AND provider <> 'password'
        LIMIT 5`,
      [address]
    );

    return {
      found: false,
      address,
      otherProviders: others.map((other) => String(other.provider)).filter(Boolean),
    };
  }

  const [accounts] = await connection.execute(
    'SELECT eso_account_name FROM itemshare_accounts WHERE user_id = ? ORDER BY eso_account_name',
    [Number(row.user_id)]
  );

  return {
    found: true,
    address,
    userId: Number(row.user_id),
    displayName: String(row.display_name || ''),
    hasPassword: Number(row.has_password) > 0,
    accounts: accounts.map((account) => String(account.eso_account_name)),
  };
}

/**
 * Ends every signed-in session this person has.
 *
 * Sessions are JSON rows in itemshare_sessions with the person under `user.id`, so the id
 * is read out of the JSON rather than kept in a column of its own: no migration, and no
 * second copy of the answer to disagree with the session itself. A password reset is how
 * somebody takes an account back, so a session that was already open must not stay open -
 * otherwise whoever knew the old password keeps their access.
 *
 * The website path does the same thing inside `consumePasswordReset` (lib/store.js), in
 * the same transaction as the new hash.
 *
 * @returns {Promise<number>} how many sessions were ended
 */
export async function signOutEverywhere(connection, userId) {
  const id = Number(userId);

  if (!Number.isInteger(id) || id <= 0) {
    return 0;
  }

  const [result] = await connection.execute(
    `DELETE FROM itemshare_sessions
      WHERE CAST(JSON_EXTRACT(session_data, '$.user.id') AS UNSIGNED) = ?`,
    [id]
  );

  return Number(result?.affectedRows) || 0;
}

/**
 * Writes one hash for one person. The identity row is what the sign-in reads, so this is
 * the whole reset: no other table records a password.
 */
export async function setPassword(connection, userId, passwordHash) {
  const id = Number(userId);
  const [result] = await connection.execute(
    `INSERT INTO itemshare_passwords (user_id, password_hash) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
    [id, String(passwordHash)]
  );

  // mysql2 reports 1 row for an insert and 2 for a changed existing row, which is the
  // difference between repairing a missing row and replacing one.
  return { userId: id, created: Number(result?.affectedRows) === 1 };
}

/** Reads one line without echoing it, for the terminal. */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const wasRaw = Boolean(stdin.isRaw);

    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    let done = false;

    const finish = (error) => {
      if (done) {
        return;
      }
      done = true;
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write('\n');

      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    const onData = (chunk) => {
      if (String(chunk).startsWith('\u001b')) {
        return; // an arrow key or a paste marker: nothing to add
      }

      for (const char of String(chunk)) {
        if (char === '\r' || char === '\n') {
          return finish();
        }
        if (char === '\u0003') {
          return finish(new Error('Cancelled.'));
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= ' ') {
          value += char;
        }
      }

      return undefined;
    };

    stdin.on('data', onData);
  });
}

/** The first line of a pipe, for a reset script. */
async function readPipedPassword() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const email = args.find((arg) => !arg.startsWith('-'));
  const dryRun = args.includes('--dry-run');

  if (!email) {
    console.error(USAGE);
    return 2;
  }

  if (!emailLooksValid(email)) {
    console.error(`"${email}" does not look like an email address.`);
    return 1;
  }

  const address = normalizeEmail(email);
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
    const account = await findPasswordAccount(connection, address);

    if (!account.found) {
      console.error(`No email and password sign-in for ${address}.`);

      if (account.otherProviders.length > 0) {
        console.error(
          `That address belongs to ${account.otherProviders.join(', ')}, where the provider ` +
            'holds the password. Sign in that way instead; there is no password here to reset.'
        );
      } else {
        console.error(
          'Nobody has signed up with that address. Check the spelling, or use ' +
            '/auth/email/signup on the site to make the account first.'
        );
      }

      return 1;
    }

    console.log(`Person:   ${account.displayName || '(no display name)'} (#${account.userId})`);
    console.log(`Sign-in:  ${account.address}`);
    console.log(`Accounts: ${account.accounts.join(', ') || '(no ESO account linked yet)'}`);
    console.log(
      `Password: ${
        account.hasPassword
          ? 'a hash is stored and will be replaced'
          : 'no row stored, so one will be created'
      }`
    );

    if (dryRun) {
      console.log('Dry run: nothing was changed.');
      return 0;
    }

    let password;

    if (process.stdin.isTTY) {
      password = await askHidden('New password: ');
      const again = await askHidden('Type it again: ');

      if (password !== again) {
        console.error('The two entries do not match; nothing was changed.');
        return 1;
      }
    } else {
      password = await readPipedPassword();
    }

    if (!password) {
      console.error('No password given; nothing was changed.');
      return 1;
    }

    let passwordHash;

    try {
      passwordHash = await hashPassword(password);
    } catch (error) {
      console.error(error.message);
      return 1;
    }

    const result = await setPassword(connection, account.userId, passwordHash);

    console.log(
      result.created
        ? `Created the password for #${result.userId}.`
        : `Replaced the password for #${result.userId}.`
    );
    const ended = await signOutEverywhere(connection, account.userId);

    console.log(
      ended === 0
        ? 'No signed-in session was open for them.'
        : `Signed out ${ended} active session${ended === 1 ? '' : 's'}.`
    );
    console.log('They can sign in with the address above and the new password.');

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
