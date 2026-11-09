#!/usr/bin/env node
// Puts a fake guildmate into your guilds, so the Request tab has something in it
// before a second person really uploads.
//
//   node seedDemo.js                  add demo items to every guild you are in
//   node seedDemo.js --account @Name  only the guilds that account is in
//   node seedDemo.js --guild 761817   only that guild id
//   node seedDemo.js --remove         take the demo rows out again
//
// A saved variables file cannot do this: every ESO account in an uploaded file is
// linked to whoever uploaded it, so a second "person" from a file would be you.
// This account is never linked to anybody, which is the point - its items appear
// under Request for anyone who shares a guild with it, exactly like a real
// guildmate's would. Everything it writes is labelled @DemoTrader and removable.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

import { describeConnectionFailure, openDatabase, readConfig } from './lib/database.js';
import { replaceAccounts } from './lib/store.js';
// The catalogue lives in lib/demoItems.js: the Demo sign-in shares the same kind of
// items from its own account, so one definition serves both.
import {
  DEMO_ACCOUNT,
  DEMO_CHARACTER,
  ITEMS,
  OFFERS,
  buildItem,
  buildOffer,
} from './lib/demoItems.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? String(process.argv[index + 1]).trim() : '';
}

async function removeDemo(connection) {
  await connection.execute('DELETE FROM itemshare_shared_items WHERE account_name = ?', [DEMO_ACCOUNT]);
  await connection.execute('DELETE FROM itemshare_always_share WHERE account_name = ?', [DEMO_ACCOUNT]);
  await connection.execute('DELETE FROM itemshare_account_guilds WHERE account_name = ?', [DEMO_ACCOUNT]);
  await connection.execute('DELETE FROM itemshare_uploads WHERE account_name = ?', [DEMO_ACCOUNT]);
}

const removeOnly = process.argv.includes('--remove');
const accountFilter = valueAfter('--account');
const guildFilter = Number(valueAfter('--guild')) || 0;

const config = readConfig();
let connection;

try {
  ({ connection } = await openDatabase(config));
} catch (error) {
  // A stack trace is noise here: the usual cause is a MariaDB that is not running,
  // which describeConnectionFailure explains in plain words.
  console.error(describeConnectionFailure(error, config));
  process.exit(1);
}

try {
  // The demo account shares into guilds that already exist, so its items are only
  // visible to people who are in those guilds - the same rule as everything else.
  const filters = ['ag.account_name <> ?'];
  const params = [DEMO_ACCOUNT];

  if (accountFilter) {
    filters.push('ag.account_name = ?');
    params.push(accountFilter);
  }
  if (guildFilter > 0) {
    filters.push('ag.guild_id = ?');
    params.push(guildFilter);
  }

  const [rows] = await connection.execute(      `SELECT ag.guild_id, COALESCE(g.guild_name, '') AS guild_name
       FROM itemshare_account_guilds ag
       LEFT JOIN itemshare_guilds g
              ON g.guild_id = ag.guild_id
             AND g.platform = ag.platform
             AND g.world_name = ag.world_name
      WHERE ${filters.join(' AND ')}
      GROUP BY ag.guild_id, g.guild_name, ag.platform, ag.world_name
      ORDER BY guild_name ASC, ag.guild_id ASC`,
    params
  );

  const guilds = new Map(rows.map((row) => [Number(row.guild_id), String(row.guild_name || '')]));

  if (guilds.size === 0) {
    console.error(
      'No guilds found for that account. Upload your ItemShareSavedVars.lua on the site first,\n' +
        'so the demo account has a guild it can share into.'
    );
    process.exitCode = 1;
  } else if (removeOnly) {
    await removeDemo(connection);
    console.log(`Removed ${DEMO_ACCOUNT} and everything it shared.`);
  } else {
    const guildIds = [...guilds.keys()];

    const [result] = await replaceAccounts(
      connection,
      [
        {
          accountName: DEMO_ACCOUNT,
          items: ITEMS.map((spec, index) => buildItem(spec, index, guildIds)),
          alwaysShare: OFFERS.map((spec, index) => buildOffer(spec, index, guildIds)),
          guilds,
          addonVersion: 'demo',
        },
      ],
      { sourceFile: 'seedDemo.js' }
    );

    const setText = (spec) => (spec.set ? ` [${spec.set}]` : '');
    const traitText = (spec) => (spec.trait ? `, ${spec.trait}` : '');

    console.log(`Seeded ${DEMO_ACCOUNT} into ${guilds.size} guild${guilds.size === 1 ? '' : 's'}:`);
    for (const [guildId, guildName] of guilds) {
      console.log(`  ${guildName || '(unnamed guild)'} ${guildId}`);
    }

    console.log('');
    console.log(`Shared items (${ITEMS.length}), with the set recorded for set pieces:`);
    for (const spec of ITEMS) {
      console.log(
        `  ${String(spec.count || 1).padStart(3)} x ${spec.name}${setText(spec)} - ` +
          `${spec.qualityName} ${spec.typeName}${traitText(spec)} (${spec.location})`
      );
    }

    console.log('');
    console.log(`Standing offers (${OFFERS.length}), offered even when no copy is in a bag:`);
    for (const spec of OFFERS) {
      console.log(
        `  ${spec.name}${setText(spec)} - ${spec.qualityName} ${spec.typeName}${traitText(spec)}`
      );
    }

    console.log('');
    console.log(
      `${result.itemCount} items and ${result.alwaysShareCount} standing offers are now shared from ${DEMO_ACCOUNT}.`
    );
    console.log(
      'Every set piece above carries its set name, so the site can group and label it; an item with no\n' +
        'set stays blank there on purpose.'
    );
    console.log('Reload the site: they appear under Request. Take them out with --remove.');
  }
} finally {
  await connection.end();
}
