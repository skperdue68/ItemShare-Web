#!/usr/bin/env node
// Puts requests whose hold ran out back into the requester's basket.
//
//   npm run requests:reopen -- --dry-run
//   npm run requests:reopen -- --email someone@example.com
//   npm run requests:reopen -- --account @Ghost --item dagger
//   npm run requests:reopen -- --id 128 --minutes 30
//   npm run requests:reopen -- --all
//
// A request starts as a `draft` holding part of a stack, and stops holding it when its
// deadline passes; the site's sweeper then marks it `expired`. That row was never sent, so
// no owner was ever told about it - reopening it makes the copies held again and puts it
// back in the basket, where Send requests is. It is deliberately not turned into a
// `pending` request: the owner's email is sent when a basket is submitted, so a row made
// pending here would be a promise nobody was ever told about.
//
// What is reopened is measured against what is free now, because the world moves while a
// hold is gone: a stack can come back smaller, or somebody else can hold the copies. Rows
// that no longer fit are listed with the reason and left alone.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { describeConnectionFailure, openDatabase, readConfig } from './lib/database.js';
import { DEFAULT_HOLD_MINUTES, reopenExpiredRequests } from './lib/store.js';

// Read .env by absolute path, the way the site and the other CLIs do, so running this from
// anywhere finds the same credentials instead of quietly using defaults.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');
const hasEnvFile = existsSync(envPath);
dotenv.config({ path: envPath });

export const USAGE = `Usage: node reopenRequests.js <scope> [options]

Puts requests whose hold ran out back into the requester's basket. An expired
request was never sent, so no owner is told anything: the copies are held again and
the row is back under "In your basket", where Send requests is.

Say which requests - a run with no scope changes nothing:

  --all                Every expired request in the database
  --id <n>             One request id. Repeat it, or comma-separate: --id 12,13
  --email <address>    Only that person's requests
  --account <@Name>    Only requests asked from that ESO account
  --item <text>        Only items whose name contains this text

Options:

  --minutes <n>   How long the reopened hold lasts. Default ${DEFAULT_HOLD_MINUTES}, at most 120
  --limit <n>     Stop after n requests
  --dry-run       Say what would be reopened, write nothing
  --help, -h      This text

Reads the same .env as the site, from this folder: MARIADB_HOST, MARIADB_PORT,
MARIADB_USER, MARIADB_PASSWORD and ITEMSHARE_DATABASE.

Exit codes: 0 reopened (or a dry run that found something), 1 nothing matched or
everything was skipped, 2 usage.`;

/** The flags that take a value, so a bare `--email` is a usage error rather than empty. */
const VALUE_FLAGS = new Set(['--id', '--email', '--account', '--item', '--limit', '--minutes']);

/**
 * Turns the command line into the options the store takes, or into the reasons it cannot.
 *
 * Pure on purpose: the awkward part of a command that writes rows is what it does with a
 * half-typed flag, and that is worth testing without a database.
 *
 * @returns {{options: object, problems: string[]}}
 */
export function parseArguments(argv) {
  const options = {
    ids: [],
    requesterEmail: '',
    accountName: '',
    itemText: '',
    limit: 0,
    minutes: DEFAULT_HOLD_MINUTES,
    dryRun: false,
    all: false,
    help: false,
  };
  const problems = [];

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (flag === '--help' || flag === '-h') {
      options.help = true;
      continue;
    }

    if (flag === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (flag === '--all') {
      options.all = true;
      continue;
    }

    if (!VALUE_FLAGS.has(flag)) {
      problems.push(`unknown option ${flag}`);
      continue;
    }

    if (value === undefined || value.startsWith('--')) {
      problems.push(`${flag} needs a value`);
      continue;
    }

    index += 1;

    if (flag === '--id') {
      // One flag, several ids: `--id 12,13` is what somebody with a list in front of them
      // types, and asking for it twice should not silently keep only the last.
      for (const part of value.split(',')) {
        const id = Math.trunc(Number(part));

        if (!Number.isFinite(id) || id <= 0) {
          problems.push(`--id ${part} is not a request id`);
        } else {
          options.ids.push(id);
        }
      }
      continue;
    }

    if (flag === '--email') {
      options.requesterEmail = value.trim();
      continue;
    }

    if (flag === '--account') {
      options.accountName = value.trim();
      continue;
    }

    if (flag === '--item') {
      options.itemText = value.trim();
      continue;
    }

    const number = Math.trunc(Number(value));

    if (flag === '--limit') {
      if (!Number.isFinite(number) || number <= 0) {
        problems.push('--limit needs a whole number above zero');
      } else {
        options.limit = number;
      }
      continue;
    }

    // --minutes
    if (!Number.isFinite(number) || number < 1 || number > 120) {
      problems.push('--minutes needs a whole number from 1 to 120');
    } else {
      options.minutes = number;
    }
  }

  const scoped =
    options.all ||
    options.ids.length > 0 ||
    options.requesterEmail !== '' ||
    options.accountName !== '' ||
    options.itemText !== '';

  if (!options.help && !scoped) {
    problems.push('say which requests: --all, --id, --email, --account or --item');
  }

  return { options, problems };
}

/** The report as the lines somebody reads, so the wording can be checked without a screen. */
export function formatReport(report) {
  const lines = [];
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

  lines.push(`Hold: ${plural(report.minutes, 'minute')} from now.`);
  lines.push('');

  if (report.reopened.length === 0) {
    lines.push('Nothing to reopen: no expired request matched.');
  } else {
    lines.push(
      `${report.dryRun ? 'Would reopen' : 'Reopened'} ${plural(
        report.reopened.length,
        'request'
      )}${report.dryRun ? ' (nothing written)' : ''}:`
    );

    for (const row of report.reopened) {
      lines.push(
        `  #${row.id}  ${row.quantity}${row.capped ? ` of ${row.asked}` : ''} x ${row.itemName}` +
          `  ${row.requesterAccount || '(no account)'} -> ${row.ownerAccount}` +
          (row.capped ? '  (only what was free)' : '')
      );
    }
  }

  if (report.skipped.length > 0) {
    lines.push('');
    lines.push(`Skipped ${plural(report.skipped.length, 'request')}:`);

    for (const row of report.skipped) {
      lines.push(
        `  #${row.id}  ${row.itemName}  ${row.requesterAccount || '(no account)'} -> ` +
          `${row.ownerAccount} - ${row.reason}`
      );
    }
  }

  if (report.reopened.length > 0) {
    lines.push('');
    lines.push(
      report.dryRun
        ? 'Nothing was written. Run it again without --dry-run to hold them.'
        : 'Nothing has been sent to an owner: each row is back in the basket, and Send requests is what asks.'
    );
  }

  return lines;
}

async function run(argv) {
  const { options, problems } = parseArguments(argv);

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`reopenRequests: ${problem}`);
    }

    console.error('');
    console.error(USAGE);
    return 2;
  }

  const config = readConfig();
  let connection;

  try {
    ({ connection } = await openDatabase(config, { migrate: false }));
  } catch (error) {
    console.error(`Could not open the database: ${describeConnectionFailure(error, config)}`);
    return 1;
  }

  try {
    const report = await reopenExpiredRequests(connection, {
      ids: options.ids,
      requesterEmail: options.requesterEmail,
      accountName: options.accountName,
      itemText: options.itemText,
      limit: options.limit,
      minutes: options.minutes,
      dryRun: options.dryRun,
    });

    for (const line of formatReport(report)) {
      console.log(line);
    }

    if (report.reopened.length === 0) {
      console.log(
        hasEnvFile
          ? 'Nothing changed.'
          : 'Nothing changed. There is no .env in this folder, so the defaults were used.'
      );
      return 1;
    }

    return 0;
  } catch (error) {
    console.error(`Could not reopen the requests: ${error.message}`);
    return 1;
  } finally {
    await connection.end();
  }
}

const isDirectRun =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  process.exitCode = await run(process.argv.slice(2));
}
