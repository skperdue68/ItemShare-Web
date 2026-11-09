#!/usr/bin/env node
// Server identity: the megaserver and platform the addon now writes, how a file is read,
// and the places guild matching depends on them. No browser and no database - the parser
// runs for real, and the store's queries run against a stand-in connection that records
// what they asked for.
//
//   npm run test:server-identity

import assert from 'node:assert/strict';

import { extractShareData } from './lib/savedVars.js';
import { getAccountSummary, getViewerGuilds } from './lib/store.js';

const twoWorlds = `
ItemShareSavedVars =
{
    ["Default"] =
    {
        ["@red-castle"] =
        {
            ["$AccountWide"] =
            {
                ["worldName"] = "NA Megaserver",
                ["platformRaw"] = 2,
                ["guilds"] =
                {
                    ["1001"] = "Ghosts of the Reach",
                },
                ["characterGuilds"] =
                {
                    ["Buffy"] = { ["guildIds"] = { 1001 } },
                },
                ["sharedItems"] =
                {
                    ["|H0:item:1|h|h||bank"] =
                    {
                        ["itemName"] = "Soul Gem",
                        ["itemId"] = 1,
                        ["itemLink"] = "|H0:item:1|h|h|",
                        ["locationKey"] = "bank",
                        ["count"] = 400,
                        ["characterName"] = "Buffy",
                    },
                },
            },
        },
        ["@eu-trader"] =
        {
            ["$AccountWide"] =
            {
                ["worldName"] = "EU Megaserver",
                ["platformRaw"] = 2,
                ["guilds"] =
                {
                    ["1001"] = "EU Traders",
                },
            },
        },
    },
}
`;

// An older addon: no world anywhere, so nothing about this file may be guessed.
const olderFile = `
ItemShareSavedVars =
{
    ["Default"] =
    {
        ["@old-timer"] =
        {
            ["$AccountWide"] =
            {
                ["guilds"] = { ["2002"] = "Old Guild" },
                ["alwaysShare"] =
                {
                    ["|H0:item:9|h|h|"] =
                    {
                        ["itemName"] = "Iron Ore",
                        ["itemId"] = 9,
                        ["itemLink"] = "|H0:item:9|h|h|",
                    },
                },
            },
        },
    },
}
`;

let total = 0;
let failures = 0;

const tests = [];
const t = (label, run) => tests.push([label, run]);

// ------------------------------------------------------------------- reading the file

t('the world is read per account, not once for the file', () => {
  const parsed = extractShareData(twoWorlds);

  assert.equal(parsed.accountWorlds.get('@red-castle').worldName, 'NA Megaserver');
  assert.equal(parsed.accountWorlds.get('@red-castle').platform, 2);
  assert.equal(parsed.accountWorlds.get('@eu-trader').worldName, 'EU Megaserver');
});

t('an account that shares nothing is still an account, with its world', () => {
  const parsed = extractShareData(twoWorlds);

  assert.deepEqual(parsed.accounts.slice().sort(), ['@eu-trader', '@red-castle']);
  // One item in the whole file, and it is not the EU account's.
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].accountName, '@red-castle');
  // Its guild membership is recorded too, so the world it plays on is complete.
  assert.equal(parsed.accountGuilds.get('@eu-trader').get(1001), 'EU Traders');
});

t('the same guild id on two worlds keeps both names', () => {
  const parsed = extractShareData(twoWorlds);

  assert.equal(parsed.accountGuilds.get('@red-castle').get(1001), 'Ghosts of the Reach');
  assert.equal(parsed.accountGuilds.get('@eu-trader').get(1001), 'EU Traders');
});

t('items carry the guild of the character they came from', () => {
  const parsed = extractShareData(twoWorlds);

  assert.deepEqual(parsed.items[0].guildIds, [1001]);
});

t('a file with no world says nothing rather than guessing', () => {
  const parsed = extractShareData(olderFile);

  assert.equal(parsed.accountWorlds.size, 0);
  assert.deepEqual(parsed.accounts, ['@old-timer']);
  assert.equal(parsed.alwaysShare.length, 1);
});

// --------------------------------------------------------------- matching in the store

function recordingConnection(answer) {
  const statements = [];

  return {
    statements,
    async execute(sql, params = []) {
      statements.push({ sql: String(sql), params });
      return answer(String(sql), params);
    },
  };
}

t('the guild list joins names on id and world', async () => {
  const connection = recordingConnection(() => [
    [{ guild_id: 1001, guild_name: 'Ghosts of the Reach', platform: 2, world_name: 'NA Megaserver' }],
  ]);

  const rows = await getViewerGuilds(connection, ['@red-castle']);
  const sql = connection.statements[0].sql;

  assert.equal(rows[0].world_name, 'NA Megaserver');
  assert.match(sql, /g\.world_name = ag\.world_name/);
  assert.match(sql, /g\.platform = ag\.platform/);
  assert.match(sql, /ag\.world_name/); // selected, so a caller can show it
  assert.deepEqual(connection.statements[0].params, ['@red-castle']);
});

t('the account summary reports the server the file gave', async () => {
  const connection = recordingConnection((sql) => {
    if (/SELECT platform, world_name FROM itemshare_accounts/.test(sql)) {
      return [[{ platform: 2, world_name: 'EU Megaserver' }]];
    }
    if (/COUNT\(\*\) AS itemCount/.test(sql)) return [[{ itemCount: 3, totalQuantity: 12 }]];
    if (/COUNT\(\*\) AS guildCount/.test(sql)) return [[{ guildCount: 4 }]];
    if (/FROM itemshare_uploads/.test(sql)) return [[null]];
    if (/FROM itemshare_accounts a/.test(sql)) return [[{ user_id: 7, display_name: 'Someone' }]];
    return [[]];
  });

  const summary = await getAccountSummary(connection, '@eu-trader');

  assert.equal(summary.worldName, 'EU Megaserver');
  assert.equal(summary.platform, 2);
  assert.equal(summary.itemCount, 3);
});

t('an account with no file behind it reports no server', async () => {
  const connection = recordingConnection((sql) => {
    if (/SELECT platform, world_name FROM itemshare_accounts/.test(sql)) return [[]];
    if (/COUNT\(\*\) AS itemCount/.test(sql)) return [[{ itemCount: 0, totalQuantity: 0 }]];
    if (/COUNT\(\*\) AS guildCount/.test(sql)) return [[{ guildCount: 0 }]];
    if (/FROM itemshare_uploads/.test(sql)) return [[null]];
    if (/FROM itemshare_accounts a/.test(sql)) return [[{ user_id: 7, display_name: 'Someone' }]];
    return [[]];
  });

  const summary = await getAccountSummary(connection, '@typed-by-hand');

  assert.equal(summary.worldName, '');
  assert.equal(summary.platform, 0);
});

for (const [label, run] of tests) {
  total += 1;

  try {
    await run();
    console.log('ok   ' + label);
  } catch (error) {
    failures += 1;
    console.log('FAIL ' + label + '\n     ' + error.message);
  }
}

console.log(`\n${total - failures}/${total} checks passed`);

if (failures > 0) {
  process.exitCode = 1;
}
