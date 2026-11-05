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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const DEMO_ACCOUNT = '@DemoTrader';
const DEMO_CHARACTER = 'Wears-Too-Much';

const ITEMS = [
  {
    itemId: 76430,
    name: 'Briarheart Greatsword',
    type: 1,
    typeName: 'Weapon',
    quality: 4,
    qualityName: 'Legendary',
    trait: 'Sharpened',
    set: 'Briarheart',
    weapon: 'Greatsword',
    location: 'Inventory (Wears-Too-Much)',
    count: 1,
  },
  {
    itemId: 97228,
    name: "Mother's Sorrow Inferno Staff",
    type: 1,
    typeName: 'Weapon',
    quality: 3,
    qualityName: 'Epic',
    trait: 'Powered',
    set: "Mother's Sorrow",
    weapon: 'Inferno Staff',
    location: 'Bank',
    count: 1,
  },
  {
    itemId: 45723,
    name: "Hunding's Rage Cuirass",
    type: 2,
    typeName: 'Apparel',
    quality: 3,
    qualityName: 'Epic',
    trait: 'Impenetrable',
    set: "Hunding's Rage",
    slot: 'Chest',
    location: 'Bank',
    count: 1,
  },
  {
    itemId: 15774,
    name: 'Ring of the Twice-Born Star',
    type: 3,
    typeName: 'Jewelry',
    quality: 4,
    qualityName: 'Legendary',
    trait: 'Arcane',
    set: 'Twice-Born Star',
    slot: 'Ring',
    location: 'Inventory (Wears-Too-Much)',
    count: 1,
  },
  {
    itemId: 44868,
    name: "Necklace of the Seducer",
    type: 3,
    typeName: 'Jewelry',
    quality: 3,
    qualityName: 'Epic',
    trait: 'Arcane',
    set: 'The Seducer',
    slot: 'Neck',
    location: 'Inventory (Wears-Too-Much)',
    count: 1,
  },
  {
    itemId: 64681,
    name: 'Crown Mimic Stone',
    type: 6,
    typeName: 'Consumable',
    quality: 4,
    qualityName: 'Legendary',
    location: 'Bank',
    count: 5,
  },
  {
    itemId: 54187,
    name: 'Dwemer Frame',
    type: 5,
    typeName: 'Material',
    quality: 2,
    qualityName: 'Superior',
    location: 'Bank',
    count: 12,
  },
  {
    itemId: 120591,
    name: 'Alinor Bookshelf, Grand',
    type: 8,
    typeName: 'Furnishing',
    quality: 1,
    qualityName: 'Fine',
    location: 'Furnishing Vault (Hall of the Lunar Champion)',
    count: 1,
  },
  {
    itemId: 135279,
    name: 'Crafting Motif 26: Daggerfall Covenant Swords',
    type: 9,
    typeName: 'Style',
    quality: 3,
    qualityName: 'Epic',
    location: 'Furnishing Vault (Hall of the Lunar Champion)',
    count: 1,
  },
];

const OFFERS = [
  {
    itemId: 76431,
    name: 'Briarheart Dagger',
    type: 1,
    typeName: 'Weapon',
    quality: 4,
    qualityName: 'Legendary',
    trait: 'Precise',
    set: 'Briarheart',
  },
  {
    itemId: 64705,
    name: 'Aetherial Ambrosia',
    type: 6,
    typeName: 'Consumable',
    quality: 4,
    qualityName: 'Legendary',
  },
  {
    itemId: 60213,
    name: 'Perfect Roe',
    type: 5,
    typeName: 'Material',
    quality: 4,
    qualityName: 'Legendary',
  },
];

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? String(process.argv[index + 1]).trim() : '';
}

function itemLinkFor(itemId) {
  return `|H0:item:${itemId}:363:50:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0|h|h`;
}

function buildItem(spec, index, guildIds) {
  const link = itemLinkFor(spec.itemId);
  const seconds = Math.trunc(Date.now() / 1000) - index * 1800;

  return {
    accountName: DEMO_ACCOUNT,
    characterName: DEMO_CHARACTER,
    itemKey: `${link}||demo:${index}`,
    itemLink: link,
    itemId: spec.itemId,
    icon: '',
    itemName: spec.name,
    itemType: spec.type,
    itemTypeName: spec.typeName,
    quality: spec.quality,
    qualityName: spec.qualityName,
    trait: spec.trait || '',
    traitType: '',
    apparelSlot: spec.slot || '',
    equipType: '',
    apparelWeight: '',
    armorType: '',
    weaponType: spec.weapon || '',
    weaponHandedness: '',
    setName: spec.set || '',
    enchantName: '',
    styleName: '',
    requiredLevel: 0,
    requiredCp: 0,
    flavorText: null,
    esoData: null,
    furnitureDataId: 0,
    locationKey: `demo:${index}`,
    locationLabel: spec.location,
    itemCount: spec.count || 1,
    firstDumpedAt: seconds,
    lastDumpedAt: seconds,
    guildIds,
  };
}

function buildOffer(spec, index, guildIds) {
  const link = itemLinkFor(spec.itemId);
  const seconds = Math.trunc(Date.now() / 1000) - index * 7200;

  return {
    accountName: DEMO_ACCOUNT,
    characterName: DEMO_CHARACTER,
    itemKey: `${link}||demo-offer:${index}`,
    itemLink: link,
    itemId: spec.itemId,
    icon: '',
    itemName: spec.name,
    itemType: spec.type,
    itemTypeName: spec.typeName,
    quality: spec.quality,
    qualityName: spec.qualityName,
    trait: spec.trait || '',
    traitType: '',
    apparelSlot: spec.slot || '',
    equipType: '',
    apparelWeight: '',
    armorType: '',
    weaponType: spec.weapon || '',
    weaponHandedness: '',
    setName: spec.set || '',
    enchantName: '',
    styleName: '',
    requiredLevel: 0,
    requiredCp: 0,
    flavorText: null,
    esoData: null,
    furnitureDataId: 0,
    firstAddedAt: seconds,
    lastUpdatedAt: seconds,
    guildIds,
  };
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

  const [rows] = await connection.execute(
    `SELECT ag.guild_id, COALESCE(g.guild_name, '') AS guild_name
       FROM itemshare_account_guilds ag
       LEFT JOIN itemshare_guilds g ON g.guild_id = ag.guild_id
      WHERE ${filters.join(' AND ')}
      GROUP BY ag.guild_id, g.guild_name
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
