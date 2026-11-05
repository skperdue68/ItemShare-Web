#!/usr/bin/env node
// Stage one importer: reads ItemShareSavedVars.lua and stores its contents in
// the ItemShare MariaDB database. This is the command line equivalent of the
// website upload: each run fully replaces the items and guilds of every ESO
// account found in the file, inside one transaction.
//
//   node ingest.js [path to ItemShareSavedVars.lua or its SavedVariables folder] [--dry-run]
//
// With no path it looks for the file in the ESO folder under this user's home
// directory, so the same command works on Windows, macOS and Linux.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import 'dotenv/config';

import {
  SAVED_VARIABLES_FILE,
  findSavedVariablesFile,
  homeDirectory,
  savedVariablesCandidates,
} from './lib/savedVarsPath.js';
import { extractShareData } from './lib/savedVars.js';
import { openDatabase, readConfig } from './lib/database.js';
import { cacheItemIcons, resolveMissingIconPaths } from './lib/icons.js';
import { fillKnownIcons, replaceAccounts } from './lib/store.js';

function groupByAccount(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.accountName)) {
      groups.set(item.accountName, []);
    }
    groups.get(item.accountName).push(item);
  }
  return groups;
}
/**
 * A pasted path may be the file itself or the SavedVariables folder holding it; the
 * file name never changes, so a folder is accepted and the name appended.
 */
async function resolveGivenPath(given) {
  const absolute = path.resolve(given);

  try {
    const stats = await stat(absolute);
    if (stats.isDirectory()) {
      return path.join(absolute, SAVED_VARIABLES_FILE);
    }
  } catch {
    // Not there: report the path as given so the error names what was typed.
  }

  return absolute;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const filePath = args.find((arg) => !arg.startsWith('--'));

  const absolutePath = filePath ? await resolveGivenPath(filePath) : await findSavedVariablesFile();

  if (!absolutePath) {
    console.error(`Could not find ${SAVED_VARIABLES_FILE} under your home directory (${homeDirectory() || 'home unknown'}).`);
    console.error('Looked in:');
    for (const candidate of savedVariablesCandidates()) {
      console.error(`  ${candidate}`);
    }
    console.error('Pass the file, or its SavedVariables folder, as an argument to use another location.');
    process.exitCode = 1;
    return;
  }

  if (!filePath) {
    console.log('No path given, so this is the file found in the ESO folder under your home directory.');
  }

  const fileText = await readFile(absolutePath, 'utf8');
  const { guilds, accountGuilds, items, alwaysShare, addonVersions, accounts } =
    extractShareData(fileText);
  const groups = groupByAccount(items);
  const alwaysGroups = groupByAccount(alwaysShare);

  const totalQuantity = items.reduce((sum, item) => sum + item.itemCount, 0);
  const withGuild = items.filter((item) => item.guildIds.length > 0).length;

  console.log(`Read ${absolutePath}`);
  console.log(`  accounts: ${accounts.join(', ') || '(none)'}`);
  console.log(`  shared items: ${items.length} (${withGuild} linked to a guild), total quantity ${totalQuantity}`);
  console.log(`  always shared: ${alwaysShare.length} (not counted as inventory)`);
  console.log(
    `  addon version: ${[...new Set([...addonVersions.values()])].join(', ') || 'not recorded (addon older than 1.8.1)'}`
  );
  console.log(`  guilds: ${guilds.size}`);
  for (const [guildId, guildName] of guilds) {
    console.log(`    ${guildId} ${guildName || '(name not captured yet)'}`);
  }
  for (const accountName of accounts) {
    const memberOf = accountGuilds.get(accountName);
    const accountItems = groups.get(accountName) || [];
    console.log(
      `  ${accountName}: ${accountItems.length} items, guilds ${memberOf && memberOf.size ? [...memberOf.keys()].join(', ') : '(none)'}`
    );
    const alwaysItems = alwaysGroups.get(accountName) || [];
    if (alwaysItems.length) {
      console.log(`    always shared: ${alwaysItems.map((entry) => entry.itemName).join(', ')}`);
    }
  }

  if (dryRun) {
    console.log('Dry run: no database connection opened, nothing written.');
    return;
  }

  const config = readConfig();
  console.log(`Writing to MariaDB database "${config.database}" at ${config.host}:${config.port} as ${config.user}`);

  const { connection, migrations } = await openDatabase(config);

  try {
    // Recover icon paths before the rows are written: from the database first,
    // then from UESP by item id for anything still blank.
    const iconEntries = [...items, ...alwaysShare];
    await fillKnownIcons(connection, iconEntries).catch(() => {});

    const iconLookup = await resolveMissingIconPaths(iconEntries).catch(() => ({ resolved: 0, attempted: 0, missing: 0 }));
    if (iconLookup.attempted) {
      console.log(
        `  icons: resolved ${iconLookup.resolved} of ${iconLookup.missing} missing paths from UESP`
      );
    }

    const results = await replaceAccounts(
      connection,
      accounts.map((accountName) => ({
        accountName,
        items: groups.get(accountName) || [],
        alwaysShare: alwaysGroups.get(accountName) || [],
        addonVersion: addonVersions.get(accountName) || '',
        guilds: accountGuilds.get(accountName) || new Map(),
      })),
      { sourceFile: path.basename(absolutePath) }
    );

    for (const result of results) {
      console.log(
        `  ${result.accountName}: replaced with ${result.itemCount} items, total quantity ${result.totalQuantity}, ${result.guildCount} guilds, ${result.alwaysShareCount} always shared`
      );
    }
    const iconResult = await cacheItemIcons(connection, items.map((item) => item.icon));
    console.log(
      `  icons: fetched ${iconResult.fetched}, already stored ${iconResult.skipped}, failed ${iconResult.failed}`
    );
    console.log(`Applied migrations: ${migrations.join(', ')}`);
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(`ItemShare ingest failed: ${error.message}`);
  process.exitCode = 1;
});
