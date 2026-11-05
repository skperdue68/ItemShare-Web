#!/usr/bin/env node
// On-demand icon repair: the same pass the website runs on a timer, for when 30
// minutes is too long, plus a single-item probe for checking whether UESP knows
// an item at all.
//
//   node backfillIcons.js --id 223698         # ask UESP about one item, no database
//   node backfillIcons.js                     # one batch of missing icons
//   node backfillIcons.js --limit 20 --passes 5
//   node backfillIcons.js --dry-run           # list what is missing, change nothing

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { describeConnectionFailure, openDatabase, readConfig } from './lib/database.js';
import { getItemIdsMissingIcons, getUncachedIconItems } from './lib/store.js';
import { backfillItemIcons } from './lib/iconBackfill.js';
import { resolveIconPathByItemId } from './lib/icons.js';

// Same absolute path the server reads, so `node Database/backfillIcons.js` from
// the repository root finds the credentials too. Loading `dotenv/config` instead
// resolves .env against the shell's directory, which silently fell back to
// root with an empty password when run anywhere but Database/.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');
const hasEnvFile = existsSync(envPath);
dotenv.config({ path: envPath });

const USAGE = `Usage: node backfillIcons.js [options]

  --id <itemId>   Ask UESP about one item id and print the icon path it finds.
                  Needs no database, so it also tests the lookup on its own.
  --limit <n>     Item ids per pass (default 20, at most 200).
  --passes <n>    How many batches to run in this invocation (default 1).
  --dry-run       List the item ids that are missing an icon and change nothing.

The website retries missing icons by itself every ICON_BACKFILL_INTERVAL_MS
(default 30 minutes); this is the same pass, on demand.`;

function numberArg(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }

  const valueFor = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };

  // Single-item probe: no database, so it works even when MariaDB is down and it
  // isolates "does UESP answer at all" from everything else.
  if (valueFor('--id') !== undefined) {
    const itemId = Number(valueFor('--id'));
    console.log(`Asking UESP about item ${itemId}...`);

    const icon = await resolveIconPathByItemId(itemId);

    if (icon) {
      console.log(`  icon path:  ${icon}`);
      console.log(`  PNG mirror: https://esoicons.uesp.net${icon.replace(/\.dds$/i, '.png')}`);
      console.log('  The full chain works from this machine.');
    } else {
      console.log('  no icon path found. Either UESP refused the request (403),');
      console.log('  answered 404 for that id, or the page no longer embeds an');
      console.log('  /esoui/art/icons image.');
    }

    return;
  }

  const dryRun = args.includes('--dry-run');
  const limit = Math.min(numberArg(valueFor('--limit'), 20), 200);
  const passes = Math.min(numberArg(valueFor('--passes'), 1), 50);

  const config = readConfig();

  console.log(`Env file: ${hasEnvFile ? envPath : `${envPath} not found - copy .env.example to .env`}`);
  console.log(`Database: ${config.database} at ${config.host}:${config.port} as ${config.user}`);

  const { connection, migrations } = await openDatabase(config);

  try {
    if (migrations.length) {
      console.log(`Applied migrations: ${migrations.join(', ')}`);
    }

    if (dryRun) {
      const missing = await getItemIdsMissingIcons(connection, limit);
      const uncached = await getUncachedIconItems(connection, limit);

      console.log(
        missing.length
          ? `Missing icons: ${missing.length} item id(s) in this batch: ${missing.join(', ')}`
          : 'Missing icons: none - every item id has an icon path somewhere.'
      );
      console.log(
        uncached.length
          ? `Unfetchable icons: ${uncached.length} item id(s) whose stored path has no image: ` +
              uncached.map((row) => `${row.itemId} (${row.icon})`).join(', ')
          : 'Unfetchable icons: none - every stored path produced an image.'
      );
      console.log('Dry run: nothing looked up, nothing written.');
      return;
    }

    let totalLooked = 0;
    let totalResolved = 0;
    let totalRows = 0;
    let totalFetched = 0;

    for (let pass = 1; pass <= passes; pass += 1) {
      const result = await backfillItemIcons(connection, { limit });

      totalLooked += result.itemIds;
      totalResolved += result.resolved;
      totalRows += result.rows;
      totalFetched += result.icons.fetched;

      if (result.itemIds === 0) {
        console.log(`Pass ${pass}: nothing missing.`);
        break;
      }

      console.log(
        `Pass ${pass}: looked up ${result.itemIds}, resolved ${result.resolved}, ` +
          `filled ${result.rows} row(s), fetched ${result.icons.fetched} image(s)`
      );

      // The next pass would ask UESP the same questions and get the same answers.
      if (result.resolved === 0) {
        console.log('  Nothing resolved, so another pass would repeat the same requests; stopping.');
        break;
      }
    }

    console.log(
      `Done: ${totalLooked} item id(s) checked, ${totalResolved} resolved, ` +
        `${totalRows} row(s) updated, ${totalFetched} image(s) fetched.`
    );

    if (totalLooked > 0 && totalResolved === 0) {
      console.log('UESP returned no icon for any of them. Try: node backfillIcons.js --id <itemId>');
    }
  } finally {
    await connection.end().catch(() => {});
  }
}

main().catch((error) => {
  let config = {};

  try {
    config = readConfig();
  } catch {
    // A malformed ITEMSHARE_DATABASE is reported by the error itself.
  }

  const message = String((error && error.message) || error);

  console.error(
    /connect|ECONNREFUSED|auth_gssapi|access denied|unknown database|socket/i.test(message)
      ? describeConnectionFailure(error, config)
      : `Icon backfill failed: ${message}`
  );
  process.exitCode = 1;
});
