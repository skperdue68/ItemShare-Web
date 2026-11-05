#!/usr/bin/env node
// Pretends a few other people are using the site, so a list with one real owner looks
// like one with traffic on it.
//
//   npm run simulate                     keep going until you press Ctrl+C
//   npm run simulate -- --every 4000     one action every four seconds
//   npm run simulate -- --rounds 12      stop after twelve actions
//   npm run simulate -- --once           exactly one action, then exit
//   npm run simulate -- --only requests  asking, sending, cancelling and timing out
//   npm run simulate -- --only items     just people re-saving their files
//   npm run simulate -- --reset          remove the simulated people and their data
//   npm run simulate -- --url <address>  ask a different site to announce the changes
//
// It writes through lib/store.js, the same code the site uses, so reservations, the
// basket clock and the upload reconciliation behave exactly as they would for a real
// person - there is no second implementation to drift.
//
// The site holds the socket connections, so the script cannot push on its own. After
// each action it asks the running site to announce what happened; that needs
// SIMULATE_TOKEN in .env (the same file the site reads) and the site running. The address
// it asks is BASE_URL - the one the site publishes for its own links - so a reverse proxy
// or another port needs nothing extra here, and --url sends one run somewhere else.
// Without it the data still changes - you just see it on the next refresh.
//
// Everything it creates is labelled with a `simulator` identity, so the same three
// people come back instead of a new set on every run, and --reset removes them all.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

import { describeConnectionFailure, openDatabase, readConfig } from './lib/database.js';
import {
  cancelOwnRequest,
  createRequest,
  expireDueDrafts,
  getBasketRows,
  getSharedItemsForViewer,
  replaceAccounts,
  submitDrafts,
} from './lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const HOLD_MINUTES = 5;
const LOCATIONS = ['Inventory', 'Bank', 'Furnishing Vault', 'Craft Bag'];

// Three people, deliberately different: one has a lot of one thing, one has single
// copies, one mostly hoards materials. What they hold changes between rounds.
const PEOPLE = [
  {
    account: '@DemoTrader',
    character: 'Wears-Too-Much',
    round: 0,
    items: [
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
        count: 1,
      },
      {
        itemId: 54187,
        name: 'Dwemer Frame',
        type: 5,
        typeName: 'Material',
        quality: 2,
        qualityName: 'Superior',
        count: 12,
      },
      {
        itemId: 64681,
        name: 'Crown Mimic Stone',
        type: 6,
        typeName: 'Consumable',
        quality: 4,
        qualityName: 'Legendary',
        count: 5,
      },
    ],
    offers: [
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
    ],
  },
  {
    account: '@NightMarket',
    character: 'Sells-After-Dark',
    round: 0,
    items: [
      {
        itemId: 44868,
        name: 'Necklace of the Seducer',
        type: 3,
        typeName: 'Jewelry',
        quality: 3,
        qualityName: 'Epic',
        trait: 'Arcane',
        set: 'The Seducer',
        slot: 'Neck',
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
        count: 2,
      },
      {
        itemId: 135279,
        name: 'Crafting Motif 26: Daggerfall Covenant Swords',
        type: 9,
        typeName: 'Style',
        quality: 3,
        qualityName: 'Epic',
        count: 1,
      },
    ],
    offers: [
      {
        itemId: 60213,
        name: 'Perfect Roe',
        type: 5,
        typeName: 'Material',
        quality: 4,
        qualityName: 'Legendary',
      },
    ],
  },
  {
    account: '@QuietSmith',
    character: 'Hammers-Quietly',
    round: 0,
    items: [
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
        count: 1,
      },
      {
        itemId: 120591,
        name: 'Alinor Bookshelf, Grand',
        type: 8,
        typeName: 'Furnishing',
        quality: 1,
        qualityName: 'Fine',
        count: 3,
      },
    ],
    offers: [
      {
        itemId: 64705,
        name: 'Aetherial Ambrosia',
        type: 6,
        typeName: 'Consumable',
        quality: 4,
        qualityName: 'Legendary',
      },
    ],
  },
];

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? String(process.argv[index + 1]).trim() : '';
}

function itemLinkFor(itemId, quality) {
  return `|H0:item:${itemId}:363:${(Number(quality) || 1) * 10}:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0|h|h`;
}

/** Where this person's copy is this time round. Re-saving is how it moves. */
function locationFor(person, index) {
  const name = LOCATIONS[(person.round + index) % LOCATIONS.length];
  return name === 'Inventory' ? `Inventory (${person.character})` : name;
}

function buildItem(person, spec, index, guildIds) {
  const link = itemLinkFor(spec.itemId, spec.quality);
  const seconds = Math.trunc(Date.now() / 1000) - index * 1800;
  // Stackable things gain and lose a few between saves, which is what makes the
  // owner's upload worth watching: held counts move and requests get re-settled.
  const count = spec.count > 1 ? spec.count + (person.round % 3) : 1;

  return {
    accountName: person.account,
    characterName: person.character,
    itemKey: `${link}||sim:${person.account}:${index}`,
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
    locationKey: `sim:${person.account}:${index}`,
    locationLabel: locationFor(person, index),
    itemCount: count,
    firstDumpedAt: seconds,
    lastDumpedAt: seconds,
    guildIds,
  };
}

function buildOffer(person, spec, index, guildIds) {
  const link = itemLinkFor(spec.itemId, spec.quality);
  const seconds = Math.trunc(Date.now() / 1000) - index * 7200;

  return {
    accountName: person.account,
    characterName: person.character,
    itemKey: `${link}||sim-offer:${person.account}:${index}`,
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

/** Writes this person's whole catalogue again, exactly as their own upload would. */
async function savePerson(connection, person, guilds) {
  const guildIds = [...guilds.keys()];

  const [result] = await replaceAccounts(
    connection,
    [
      {
        accountName: person.account,
        items: person.items.map((spec, index) => buildItem(person, spec, index, guildIds)),
        alwaysShare: person.offers.map((spec, index) => buildOffer(person, spec, index, guildIds)),
        guilds,
        addonVersion: 'simulate',
      },
    ],
    { sourceFile: 'simulate.js' }
  );

  return result;
}

/**
 * A person, found or made. The identity row is what makes them the same person on
 * the next run instead of a new one every time.
 */
async function ensurePerson(connection, person) {
  const [known] = await connection.execute(
    `SELECT user_id FROM itemshare_user_identities
      WHERE provider = 'simulator' AND provider_user_id = ?
      LIMIT 1`,
    [person.account]
  );

  if (known[0]) {
    person.userId = Number(known[0].user_id);
  } else {
    const [created] = await connection.execute(
      'INSERT INTO itemshare_users (display_name, email, email_verified) VALUES (?, ?, 0)',
      [person.character, `${person.account.replace(/[^a-z0-9]/gi, '').toLowerCase()}@simulator.invalid`]
    );
    person.userId = Number(created.insertId);

    await connection.execute(
      `INSERT INTO itemshare_user_identities (provider, provider_user_id, user_id)
       VALUES ('simulator', ?, ?)`,
      [person.account, person.userId]
    );
  }

  await connection.execute(
    `INSERT INTO itemshare_accounts (eso_account_name, user_id) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
    [person.account, person.userId]
  );
}

/** The real accounts: everyone who is not one of the simulated people. */
async function realAccounts(connection) {
  const [rows] = await connection.execute(
    `SELECT a.eso_account_name
       FROM itemshare_accounts a
       LEFT JOIN itemshare_user_identities i
              ON i.user_id = a.user_id AND i.provider = 'simulator'
      WHERE i.user_id IS NULL
      ORDER BY a.eso_account_name ASC`
  );

  return rows.map((row) => String(row.eso_account_name));
}

/** The guilds those accounts are in; the simulated people share into the same ones. */
async function sharedGuilds(connection, accounts) {
  if (accounts.length === 0) {
    return new Map();
  }

  const [rows] = await connection.execute(
    `SELECT ag.guild_id, COALESCE(g.guild_name, '') AS guild_name
       FROM itemshare_account_guilds ag
       LEFT JOIN itemshare_guilds g ON g.guild_id = ag.guild_id
      WHERE ag.account_name IN (${accounts.map(() => '?').join(', ')})
      GROUP BY ag.guild_id, g.guild_name
      ORDER BY guild_name ASC, ag.guild_id ASC`,
    accounts
  );

  return new Map(rows.map((row) => [Number(row.guild_id), String(row.guild_name || '')]));
}

/**
 * Asks for something of the real owner's, the way someone browsing the Request tab
 * would: the copies that are free, a quantity that fits, and usually a send.
 */
async function requestSomething(connection, person, mine, { send = Math.random() < 0.5 } = {}) {
  const rows = await getSharedItemsForViewer(connection, [person.account], { limit: 200 });
  const candidates = rows.filter(
    (row) =>
      mine.includes(String(row.account_name)) &&
      Number(row.item_count) > Number(row.reserved || 0)
  );

  if (candidates.length === 0) {
    return null;
  }

  const item = candidates[Math.floor(Math.random() * candidates.length)];
  const free = Number(item.item_count) - Number(item.reserved || 0);
  const quantity = 1 + Math.floor(Math.random() * Math.min(free, 3));

  let outcome;

  try {
    outcome = await createRequest(connection, {
      userId: person.userId,
      requesterAccounts: [person.account],
      itemKind: 'inventory',
      itemId: Number(item.id),
      quantity,
      holdMinutes: HOLD_MINUTES,
    });
  } catch (error) {
    // Someone else took the last copy between the read and the write; next round.
    return { skipped: error.message };
  }

  const sent = send ? await submitDrafts(connection, { userId: person.userId }) : 0;

  return {
    person: person.account,
    item: outcome.itemName,
    quantity: outcome.quantity,
    owner: outcome.ownerAccountName,
    sent: sent > 0,
  };
}

/**
 * Sends the basket, asking for something first if it is empty. This is the scenario
 * the site emails the owner about; here the sentence says who would have been
 * emailed rather than sending anything.
 */
async function sendBasket(connection, person, mine) {
  let rows = (await getBasketRows(connection, person.userId)).filter(
    (row) => row.status === 'draft'
  );

  if (rows.length === 0) {
    const asked = await requestSomething(connection, person, mine, { send: false });

    if (!asked || !asked.item) {
      return null;
    }

    rows = (await getBasketRows(connection, person.userId)).filter(
      (row) => row.status === 'draft'
    );
  }

  const sent = await submitDrafts(connection, { userId: person.userId });

  if (sent === 0) {
    return null;
  }

  return {
    person: person.account,
    copies: rows.reduce((sum, row) => sum + (Number(row.quantity) || 1), 0),
    items: rows.map((row) => row.item_name),
    owners: [...new Set(rows.map((row) => String(row.owner_account_name)))],
    sent,
  };
}

/** Takes the most recent thing back out of the basket before it is ever sent. */
async function removeFromBasket(connection, person) {
  const rows = (await getBasketRows(connection, person.userId)).filter(
    (row) => row.status === 'draft'
  );

  if (rows.length === 0) {
    return null;
  }

  const row = rows[rows.length - 1];
  const outcome = await cancelOwnRequest(connection, {
    userId: person.userId,
    requestId: Number(row.id),
    holdMinutes: HOLD_MINUTES,
  });

  return outcome.cancelled
    ? {
        person: person.account,
        item: outcome.itemName || row.item_name || 'an item',
        fromBasket: true,
      }
    : null;
}

/**
 * Lets a basket run out of time. The hold is five minutes, so the clock is pushed
 * past its deadline and the site's own sweeper is run: the rows end up exactly as
 * they would for somebody who walked away and came back.
 */
async function timeoutBasket(connection, person, mine) {
  const asked = await requestSomething(connection, person, mine, { send: false });

  if (!asked || !asked.item) {
    return null;
  }

  await connection.execute(
    `UPDATE itemshare_requests
        SET expires_at = NOW() - INTERVAL 1 SECOND
      WHERE requester_user_id = ? AND status = 'draft'`,
    [person.userId]
  );

  const expired = await expireDueDrafts(connection);

  return expired > 0 ? { person: person.account, item: asked.item } : null;
}

/** Names a few items for one log sentence without dumping a whole basket into it. */
function describeItems(names) {
  const list = [...new Set((names || []).filter(Boolean))];

  if (list.length === 0) {
    return 'an item';
  }
  if (list.length <= 3) {
    return list.join(', ');
  }

  return `${list.slice(0, 3).join(', ')} and ${list.length - 3} more`;
}

/** Saves their file again: items move, stacks change, requests get re-settled. */
async function saveSomething(connection, person, guilds) {
  person.round += 1;
  const result = await savePerson(connection, person, guilds);

  return {
    person: person.account,
    items: result.itemCount,
    where: person.items.map((_, index) => locationFor(person, index)).slice(0, 2).join(' / '),
  };
}

// Where the site answers. BASE_URL is the address the site already publishes for its own
// links and sign-in redirects, so it is already right behind a proxy or on another port;
// --url overrides it for one run, and a missing scheme is filled in because "host:port"
// is what people type.
function siteBaseUrl() {
  const chosen = String(valueAfter('--url') || process.env.BASE_URL || '').trim();
  const base = chosen || `http://127.0.0.1:${process.env.PORT || 3000}`;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(base) ? base : `http://${base}`;

  return withScheme.replace(/\/+$/, '');
}

async function nudge(summary) {
  const token = String(process.env.SIMULATE_TOKEN || '').trim();

  if (!token) {
    // Nothing worth a line of its own: the data still changed, and the next refresh
    // - or the next thing the reader does - shows it.
    return '';
  }

  try {
    const response = await fetch(`${SITE_URL}/simulate/nudge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-itemshare-simulate': token,
      },
      body: new URLSearchParams({ summary }).toString(),
    });

    if (!response.ok) {
      // 404 is the site's own answer when its token is blank or different, deliberately
      // indistinguishable from a missing route, so say which knob to check.
      const hint =
        response.status === 404 ? ' (it hides the route unless SIMULATE_TOKEN matches)' : '';

      return `the site answered ${response.status}${hint}, so open pages were not told`;
    }

    const result = await response.json().catch(() => ({}));
    const clients = Number(result.clients) || 0;

    return clients === 0
      ? 'no pages open to refresh'
      : `${clients} open page${clients === 1 ? '' : 's'} told to refresh`;
  } catch (error) {
    return `could not reach the site on ${SITE_URL} (${error.message})`;
  }
}

// Ctrl+C stops after the action in flight and cuts the wait short, so stopping is
// immediate rather than "in up to ten seconds".
let stopping = false;
let wake = null;

process.on('SIGINT', () => {
  stopping = true;

  if (wake) {
    wake();
  } else {
    console.log('\nStopping after this action...');
  }
});

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);

    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });
}

const once = process.argv.includes('--once');
const wanted = Number(valueAfter('--rounds'));
const rounds = once
  ? 1
  : Number.isFinite(wanted) && wanted > 0
    ? Math.trunc(wanted)
    : Number.POSITIVE_INFINITY;
const every = Math.max(0, Number(valueAfter('--every')) || (once ? 0 : 10000));
const only = valueAfter('--only');
const removing = process.argv.includes('--reset');
const SITE_URL = siteBaseUrl();

const config = readConfig();
let connection;

try {
  ({ connection } = await openDatabase(config));
} catch (error) {
  console.error(describeConnectionFailure(error, config));
  process.exit(1);
}

try {
  for (const person of PEOPLE) {
    await ensurePerson(connection, person);
  }

  if (removing) {
    const userIds = PEOPLE.map((person) => person.userId);
    const accounts = PEOPLE.map((person) => person.account);
    const userMarks = userIds.map(() => '?').join(', ');
    const accountMarks = accounts.map(() => '?').join(', ');

    await connection.execute(
      `DELETE FROM itemshare_requests WHERE requester_user_id IN (${userMarks})`,
      userIds
    );
    await connection.execute(
      `DELETE FROM itemshare_shared_items WHERE account_name IN (${accountMarks})`,
      accounts
    );
    await connection.execute(
      `DELETE FROM itemshare_always_share WHERE account_name IN (${accountMarks})`,
      accounts
    );
    await connection.execute(
      `DELETE FROM itemshare_account_guilds WHERE account_name IN (${accountMarks})`,
      accounts
    );
    await connection.execute(
      `DELETE FROM itemshare_uploads WHERE account_name IN (${accountMarks})`,
      accounts
    );
    await connection.execute(
      `DELETE FROM itemshare_accounts WHERE eso_account_name IN (${accountMarks})`,
      accounts
    );
    await connection.execute(
      `DELETE FROM itemshare_user_identities WHERE provider = 'simulator' AND provider_user_id IN (${accountMarks})`,
      accounts
    );
    await connection.execute(`DELETE FROM itemshare_users WHERE id IN (${userMarks})`, userIds);

    console.log(`Removed ${PEOPLE.length} simulated people and everything they shared.`);
  } else {
    const mine = await realAccounts(connection);
    const guilds = await sharedGuilds(connection, mine);

    if (mine.length === 0) {
      console.error(
        'No real ESO account found. Upload your ItemShareSavedVars.lua on the site first,\n' +
          'so the simulated people have a guildmate to share with.'
      );
      process.exitCode = 1;
    } else if (guilds.size === 0) {
      console.error(
        'That account is in no guilds, so nothing would be visible to anyone.\n' +
          'Upload a file from an account that is in a guild.'
      );
      process.exitCode = 1;
    } else {
      // Their files have to exist before anyone can ask for what is in them.
      for (const person of PEOPLE) {
        await savePerson(connection, person, guilds);
      }

      const order =
        only === 'items'
          ? ['save']
          : only === 'requests'
            ? ['request', 'send', 'cancel', 'timeout']
            : ['request', 'send', 'cancel', 'timeout', 'save'];

      console.log(
        `Simulating ${PEOPLE.length} people into ${guilds.size} guild${
          guilds.size === 1 ? '' : 's'
        } alongside ${mine.join(', ')}.`
      );
      console.log(
        `${only ? `Only ${only}` : 'A mix of asks, sends, cancels, timeouts and re-saves'}${
          Number.isFinite(rounds)
            ? `, ${rounds} action${rounds === 1 ? '' : 's'}`
            : ', running until you stop it'
        }${every > 0 ? `, one every ${Math.round(every / 1000)}s` : ''}.`
      );

      if (String(process.env.SIMULATE_TOKEN || '').trim()) {
        console.log(`Live pushes: ${SITE_URL}/simulate/nudge`);
      }

      if (!Number.isFinite(rounds) || rounds > 1) {
        console.log('Press Ctrl+C to stop.');
      }

      let acted = 0;

      while (acted < rounds && !stopping) {
        acted += 1;

        const action = order[Math.floor(Math.random() * order.length)];
        const person = PEOPLE[Math.floor(Math.random() * PEOPLE.length)];
        let line = '';

        if (action === 'request') {
          const done = await requestSomething(connection, person, mine);

          if (done && done.item) {
            line = `${done.person} asked ${done.owner} for ${done.quantity} x ${done.item}${
              done.sent ? ' and sent it straight away' : ' (still in their basket)'
            }`;
          } else {
            line = `nothing free to ask for right now (${person.account})`;
          }
        } else if (action === 'send') {
          const done = await sendBasket(connection, person, mine);

          line = done
            ? `${done.person} sent ${done.sent} request${done.sent === 1 ? '' : 's'} (${done.copies} cop${
                done.copies === 1 ? 'y' : 'ies'
              }) for ${describeItems(done.items)} to ${done.owners.join(
                ', '
              )} - the owner would be emailed`
            : `nothing for ${person.account} to send`;
        } else if (action === 'cancel') {
          // Only a basket row can be taken back now: once a request has been sent it
          // stays in the requester's history, so there is nothing here to cancel.
          const done = await removeFromBasket(connection, person);

          line = done
            ? `${done.person} took back their request for ${done.item}`
            : `nothing in ${person.account}'s basket to take back`;
        } else if (action === 'timeout') {
          const done = await timeoutBasket(connection, person, mine);

          line = done
            ? `${done.person} let the basket clock run out, so ${describeItems([
                done.item,
              ])} went back to being available`
            : `nothing to time out for ${person.account}`;
        } else {
          const done = await saveSomething(connection, person, guilds);
          line = `${done.person} saved again: ${done.items} items, now in ${done.where}`;
        }

        console.log(`[${new Date().toLocaleTimeString()}] ${line}`);

        const live = await nudge(line);

        if (live) {
          console.log(`  live: ${live}`);
        }

        if (every > 0 && acted < rounds && !stopping) {
          await sleep(every);
        }
      }

      console.log(
        `Stopped after ${acted} action${acted === 1 ? '' : 's'}. ` +
          'Undo everything with: npm run simulate -- --reset'
      );
    }
  }
} finally {
  await connection.end();
}
