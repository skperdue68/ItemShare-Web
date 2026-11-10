#!/usr/bin/env node
// Removes one person and everything attached to them, run on the server that holds the
// database.
//
//   ./deleteUser.js someone@example.com
//   ./deleteUser.js someone@example.com --dry-run
//   ./deleteUser.js someone@example.com --yes
//   ./deleteUser.js --id 12 --yes
//
// The name is the login: the address of an email and password sign-in, a Discord or Google
// address, the provider's username, or the display name it gave them. `--id` is there for
// the case where two people answer to the same name.
//
// Everything the person owns goes with them, in one transaction, so no row is left pointing
// at a person or an ESO account that is gone: their shared items, their standing offers,
// guild memberships, uploads, baskets, requests asked for or owed on their accounts, the
// guild codes they created and the redemptions of them, their sign-in sessions, identities,
// password and reset rows, their ESO account links, and the person row itself.
//
// Guilds and the item icon and tip caches are shared by everybody and are deliberately
// kept. A membership another person was granted with one of this person's codes keeps the
// guild and loses only the provenance: `granted_code_id` becomes NULL, so a deletion here
// never takes somebody else's invitation away.
//
// After the deletes the script counts every known reference again. Anything still attached
// is a mistake in this list rather than something to live with, so the transaction is
// rolled back and the leftovers are printed instead of being committed.
//
// `--dry-run` runs the same statements and then rolls back, so the counts it prints are the
// real ones and nothing changes.
//
// Reads the same .env as the site, from this folder: MARIADB_HOST, MARIADB_PORT,
// MARIADB_USER, MARIADB_PASSWORD and ITEMSHARE_DATABASE.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import dotenv from 'dotenv';

import { describeConnectionFailure, openDatabase, readConfig } from './lib/database.js';
import { normalizeEmail } from './lib/passwords.js';

// Read .env by absolute path, the way the server and the other CLIs do, so running this
// from anywhere finds the same credentials instead of silently using defaults.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');
const hasEnvFile = existsSync(envPath);
dotenv.config({ path: envPath });

export const USAGE = `Usage: node deleteUser.js <login> [options]

Removes one person and everything attached to them: their ESO accounts with the items
and offers on them, their requests, guild codes and redemptions, sign-in rows and
sessions. It runs as one transaction, and refuses to commit if anything still points
at the person afterwards.

  <login>        The name they sign in with: an email address, a provider username, or
                 the display name the provider gave them
  --id <n>       The person id, for when two people answer to the same name
  --dry-run      Run the same statements, print the counts, then roll back
  --yes          Skip the confirmation. Required when nothing can be typed
  --help, -h     This text

Reads the same .env as the site, from this folder: MARIADB_HOST, MARIADB_PORT,
MARIADB_USER, MARIADB_PASSWORD and ITEMSHARE_DATABASE.

Exit codes: 0 removed (or a dry run that found them), 1 nothing found or something was
left behind, 2 usage.`;

/** One `?, ?, ?` list for an IN clause of this length. */
const placeholders = (count) => Array.from({ length: count }, () => '?').join(', ');

/** The account names, cleaned, without repeats. */
function accountList(accountNames) {
  return [
    ...new Set(
      (accountNames || []).map((name) => String(name || '').trim()).filter(Boolean)
    ),
  ];
}

/**
 * The statements that take one person out, in the order they have to run.
 *
 * Pure on purpose: the order is the whole safety of a destructive command - a request that
 * outlives the account it names, or an account deleted before the items on it - and that is
 * worth checking without a database.
 *
 * @param {{userId: number, accountNames?: string[]}} input
 * @returns {Array<{label: string, sql: string, params: Array<string|number>}>}
 */
export function removalPlan({ userId, accountNames = [] }) {
  const id = Number(userId);
  const names = accountList(accountNames);
  const inNames = names.length ? `(${placeholders(names.length)})` : '';
  const steps = [];

  const add = (label, sql, params) => steps.push({ label, sql, params });

  // A request is a promise made to somebody, so it goes before the rows it points at and
  // before the person: one they asked for, one asked of their account, or one they asked
  // from one of their own accounts.
  add(
    'requests asked for or owed on them',
    `DELETE FROM itemshare_requests
      WHERE requester_user_id = ?${
        names.length
          ? `
         OR requester_account_name IN ${inNames}
         OR owner_account_name IN ${inNames}`
          : ''
      }`,
    [id, ...names, ...names]
  );

  if (names.length) {
    // Hands that could still be waiting on one of their items are gone, and so is the row
    // itself.
    add(
      'guild memberships of their accounts',
      `DELETE FROM itemshare_account_guilds WHERE account_name IN ${inNames}`,
      names
    );
    add(
      'shared items',
      `DELETE FROM itemshare_shared_items WHERE account_name IN ${inNames}`,
      names
    );
    add(
      'standing offers',
      `DELETE FROM itemshare_always_share WHERE account_name IN ${inNames}`,
      names
    );
    add(
      'uploads of their accounts',
      `DELETE FROM itemshare_uploads WHERE account_name IN ${inNames} OR user_id = ?`,
      [...names, id]
    );
    // Anybody left browsing as one of these accounts would see an account that no longer
    // exists; empty means "the oldest one still linked", which is right again afterwards.
    add(
      'other people browsing as one of their accounts',
      `UPDATE itemshare_users SET browsing_eso_account_name = ''
        WHERE browsing_eso_account_name IN ${inNames}`,
      names
    );
  } else {
    add('uploads they made', 'DELETE FROM itemshare_uploads WHERE user_id = ?', [id]);
  }

  // A code can be the only reason somebody else is in a guild, so the membership stays and
  // only the record of which code granted it goes.
  add(
    'codes their invitations came from',
    `UPDATE itemshare_account_guilds SET granted_code_id = NULL
      WHERE granted_code_id IN (
        SELECT id FROM itemshare_guild_codes WHERE created_by_user_id = ?
      )`,
    [id]
  );
  add(
    'redemptions of their codes',
    `DELETE FROM itemshare_guild_code_redemptions
      WHERE user_id = ?
         OR code_id IN (
           SELECT id FROM itemshare_guild_codes WHERE created_by_user_id = ?
         )`,
    [id, id]
  );
  add(
    'guild codes they created',
    'DELETE FROM itemshare_guild_codes WHERE created_by_user_id = ?',
    [id]
  );
  add(
    'their ESO accounts',
    `DELETE FROM itemshare_accounts WHERE user_id = ?${
      names.length ? ` OR eso_account_name IN ${inNames}` : ''
    }`,
    [id, ...names]
  );
  // Sessions keep the person inside their JSON blob rather than in a column of their own,
  // which is why this one reads it out instead of comparing a foreign key.
  add(
    'signed-in sessions',
    `DELETE FROM itemshare_sessions
      WHERE CAST(JSON_EXTRACT(session_data, '$.user.id') AS UNSIGNED) = ?`,
    [id]
  );
  add('sign-in identities', 'DELETE FROM itemshare_user_identities WHERE user_id = ?', [id]);
  add('password', 'DELETE FROM itemshare_passwords WHERE user_id = ?', [id]);
  add('password resets', 'DELETE FROM itemshare_password_resets WHERE user_id = ?', [id]);
  add('the person', 'DELETE FROM itemshare_users WHERE id = ?', [id]);

  return steps;
}

/**
 * The same references, counted rather than deleted, for the check that runs after the plan.
 *
 * Anything still found here is a bug: it means `removalPlan` missed a table, or a row names
 * the person somewhere it was not expected. The caller rolls back on a non-zero count.
 *
 * @param {{userId: number, accountNames?: string[]}} input
 * @returns {Array<{label: string, sql: string, params: Array<string|number>}>}
 */
export function leftoverChecks({ userId, accountNames = [] }) {
  const id = Number(userId);
  const names = accountList(accountNames);
  const inNames = names.length ? `(${placeholders(names.length)})` : '';
  const checks = [];

  const add = (label, sql, params) => checks.push({ label, sql, params });
  const count = (label, table, where, params) =>
    add(label, `SELECT COUNT(*) AS found FROM ${table} WHERE ${where}`, params);

  if (names.length) {
    count('shared items', 'itemshare_shared_items', `account_name IN ${inNames}`, names);
    count('standing offers', 'itemshare_always_share', `account_name IN ${inNames}`, names);
    count('guild memberships', 'itemshare_account_guilds', `account_name IN ${inNames}`, names);
    add(
      'uploads',
      `SELECT COUNT(*) AS found FROM itemshare_uploads
        WHERE account_name IN ${inNames} OR user_id = ?`,
      [...names, id]
    );
    add(
      'accounts',
      `SELECT COUNT(*) AS found FROM itemshare_accounts
        WHERE user_id = ? OR eso_account_name IN ${inNames}`,
      [id, ...names]
    );
  } else {
    count('uploads', 'itemshare_uploads', 'user_id = ?', [id]);
    count('accounts', 'itemshare_accounts', 'user_id = ?', [id]);
  }

  add(
    'requests',
    `SELECT COUNT(*) AS found FROM itemshare_requests
      WHERE requester_user_id = ?${
        names.length
          ? `
         OR requester_account_name IN ${inNames}
         OR owner_account_name IN ${inNames}`
          : ''
      }`,
    [id, ...names, ...names]
  );
  count('guild codes', 'itemshare_guild_codes', 'created_by_user_id = ?', [id]);
  add(
    'code redemptions',
    `SELECT COUNT(*) AS found FROM itemshare_guild_code_redemptions WHERE user_id = ?`,
    [id]
  );
  add(
    'sessions',
    `SELECT COUNT(*) AS found FROM itemshare_sessions
      WHERE CAST(JSON_EXTRACT(session_data, '$.user.id') AS UNSIGNED) = ?`,
    [id]
  );
  count('identities', 'itemshare_user_identities', 'user_id = ?', [id]);
  count('password', 'itemshare_passwords', 'user_id = ?', [id]);
  count('password resets', 'itemshare_password_resets', 'user_id = ?', [id]);
  count('the person', 'itemshare_users', 'id = ?', [id]);

  return checks;
}

/**
 * Turns the command line into what the run needs, or into the reasons it cannot start.
 *
 * Pure, like the plan: a half-typed flag on a destructive command should be answered with
 * a usage error rather than with a guess.
 *
 * @returns {{options: {login: string, id: number, dryRun: boolean, yes: boolean},
 *   problems: string[]}}
 */
export function parseArguments(argv) {
  const options = { login: '', id: 0, dryRun: false, yes: false };
  const problems = [];
  const words = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? '');

    if (!arg.startsWith('-')) {
      words.push(arg);
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--yes') {
      options.yes = true;
      continue;
    }

    if (arg === '--id') {
      const number = Number(argv[index + 1]);
      index += 1;

      if (!Number.isInteger(number) || number <= 0) {
        problems.push('--id needs a person id, as in --id 12.');
      } else {
        options.id = number;
      }
      continue;
    }

    problems.push(`${arg} is not a flag this command knows. See --help.`);
  }

  if (words.length > 1) {
    problems.push(`Only one login name can be given, and ${words.length} were.`);
  } else if (words.length === 1) {
    options.login = words[0];
  }

  if (options.login && options.id) {
    problems.push('Give a login name or --id, not both.');
  }

  return { options, problems };
}

/** The people one login or id names. More than one means the caller has to pick. */
export async function resolvePeople(connection, { login = '', id = 0 } = {}) {
  const shape = (row) => ({
    id: Number(row.id),
    displayName: String(row.display_name || ''),
    email: String(row.email || ''),
    isDemo: Number(row.is_demo) > 0,
  });

  if (id) {
    const [rows] = await connection.execute(
      'SELECT id, display_name, email, is_demo FROM itemshare_users WHERE id = ?',
      [Number(id)]
    );

    return rows.map(shape);
  }

  const needle = String(login || '').trim();
  const address = normalizeEmail(needle);

  // The password identity stores the address as its subject and Discord or Google keeps the
  // username they were given, so all three are matched. The collation is case-insensitive,
  // so an address typed in another case still finds its row.
  const [rows] = await connection.execute(
    `SELECT DISTINCT u.id, u.display_name, u.email, u.is_demo
       FROM itemshare_users u
       LEFT JOIN itemshare_user_identities i ON i.user_id = u.id
      WHERE u.email = ? OR i.provider_user_id = ? OR i.provider_email = ?
         OR i.provider_username = ?
      ORDER BY u.id ASC`,
    [address, needle, address, needle]
  );

  return rows.map(shape);
}

/** The ESO accounts linked to one person. */
export async function accountsForUser(connection, userId) {
  const [rows] = await connection.execute(
    `SELECT eso_account_name FROM itemshare_accounts
      WHERE user_id = ? ORDER BY eso_account_name`,
    [Number(userId)]
  );

  return rows.map((row) => String(row.eso_account_name || '')).filter(Boolean);
}

function report(heading, rows) {
  console.log(`\n${heading}:`);

  const width = rows.reduce((max, row) => Math.max(max, row.label.length), 0);

  for (const row of rows) {
    console.log(`  ${row.label.padEnd(width)}  ${row.count}`);
  }
}

/** One line of terminal input, without hiding what is typed: this is a name, not a secret. */
function askLine(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return rl
    .question(question)
    .finally(() => rl.close());
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const { options, problems } = parseArguments(argv);

  if (problems.length === 0 && !options.login && !options.id) {
    problems.push('Name the person to remove, or give --id.');
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(problem);
    }
    console.error(`\n${USAGE}`);
    return 2;
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
    const people = await resolvePeople(connection, options);

    if (people.length === 0) {
      console.error(`Nobody signs in as "${options.login || `#${options.id}`}".`);
      console.error('Check the spelling, or pass --id with the person id shown on the site.');
      return 1;
    }

    if (people.length > 1) {
      console.error(`"${options.login}" is more than one person:`);
      for (const person of people) {
        console.error(
          `  #${person.id}  ${person.displayName || '(no display name)'}  ${person.email}`
        );
      }
      console.error(`Pick one with --id, for example --id ${people[0].id}.`);
      return 1;
    }

    const person = people[0];
    const accountNames = await accountsForUser(connection, person.id);
    const plan = removalPlan({ userId: person.id, accountNames });
    const checks = leftoverChecks({ userId: person.id, accountNames });
    const name = options.login || `#${person.id}`;

    console.log(`Person:   ${person.displayName || '(no display name)'} (#${person.id})`);
    console.log(`Sign-in:  ${person.email || name}`);
    console.log(`Accounts: ${accountNames.join(', ') || '(no ESO account linked)'}`);

    if (person.isDemo) {
      console.log(
        'Note:     this is the demo sign-in; removing it leaves demo mode with no person to sign in as.'
      );
    }

    if (!options.dryRun && !options.yes) {
      if (!process.stdin.isTTY) {
        console.error('Refusing to remove anybody without --yes when nothing can be typed.');
        return 2;
      }

      const typed = await askLine(`Type ${name} again to remove this person: `);

      if (typed.trim() !== String(name).trim()) {
        console.error('That is not the same name; nothing was changed.');
        return 1;
      }
    }

    await connection.beginTransaction();

    try {
      const removed = [];

      for (const step of plan) {
        const [result] = await connection.execute(step.sql, step.params);
        removed.push({ label: step.label, count: Number(result?.affectedRows) || 0 });
      }

      const leftovers = [];

      for (const check of checks) {
        const [rows] = await connection.execute(check.sql, check.params);
        const found = Number(rows[0]?.found) || 0;

        if (found > 0) {
          leftovers.push({ label: check.label, count: found });
        }
      }

      report('Removed', removed);

      if (leftovers.length > 0) {
        await connection.rollback();
        report('Still attached, so nothing was committed', leftovers);
        console.error('Nothing was changed: this command has a table to learn about.');
        return 1;
      }

      if (options.dryRun) {
        await connection.rollback();
        console.log('\nDry run: the transaction was rolled back, so nothing was changed.');
        return 0;
      }

      await connection.commit();
      console.log(
        `\nRemoved ${person.displayName || 'the person'} (#${person.id}). Nothing of theirs is left in the database.`
      );
      return 0;
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    }
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
