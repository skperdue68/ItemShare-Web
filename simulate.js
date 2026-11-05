#!/usr/bin/env node
// Pretends a few other people are using the site, so a list with one real owner looks
// like one with traffic on it.
//
//   npm run simulate                     keep going until you press Ctrl+C
//   npm run simulate -- --every 4000     one action every four seconds
//   npm run simulate -- --rounds 12      stop after twelve actions
//   npm run simulate -- --once           exactly one action, then exit
//   npm run simulate -- --only requests  asking, sending, answering, cancelling, timing out
//   npm run simulate -- --only items     just people re-saving their files
//   npm run simulate -- --reset          remove the simulated people and their data
//   npm run simulate -- --url <address>  ask a different site to announce the changes
//                                        (or --url=<address>; BASE_URL is used otherwise)
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
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

import { describeConnectionFailure, openDatabase, readConfig } from './lib/database.js';
import { tokenFingerprint } from './lib/simulateToken.js';
import {
  cancelOwnRequest,
  createRequest,
  expireDueDrafts,
  getBasketRows,
  getSharedItemsForViewer,
  recordOwnerGroupAnswer,
  replaceAccounts,
  submitDrafts,
} from './lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '.env');
dotenv.config({ path: ENV_PATH });

// Every line this script prints goes through here. With the site and the simulator in
// one terminal there is otherwise no way to tell a handover somebody made from one the
// simulation made; the site labels its own side of it the same way.
const LABEL = '[SIMULATE] ';

const say = (text) => console.log(`${LABEL}${text}`);
const warn = (text) => console.warn(`${LABEL}${text}`);
const fail = (text) => console.error(`${LABEL}${text}`);

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
  // Both spellings: `--url <address>` and `--url=<address>`. The second used to be
  // ignored without a word, which quietly sent a run to the address it was not given.
  const inline = process.argv.find((argument) => argument.startsWith(`${flag}=`));

  if (inline) {
    return String(inline.slice(flag.length + 1)).trim();
  }

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
 * Asks for something a guildmate has spare, the way someone browsing the Request tab
 * would: the copies that are free, a quantity that fits, and usually a send.
 *
 * Anything visible will do, and that includes the other simulated people's items - they
 * are guildmates with spares like anyone else, and skipping them left every request
 * landing on the one real owner. Only this person's own account is left out, because the
 * store refuses a request for your own copy.
 */
async function requestSomething(connection, person, { send = Math.random() < 0.5 } = {}) {
  const rows = await getSharedItemsForViewer(connection, [person.account], { limit: 500 });
  const candidates = rows.filter(
    (row) =>
      String(row.account_name) !== person.account &&
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
async function sendBasket(connection, person) {
  let rows = (await getBasketRows(connection, person.userId)).filter(
    (row) => row.status === 'draft'
  );

  if (rows.length === 0) {
    const asked = await requestSomething(connection, person, { send: false });

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
        quantity: Number(row.quantity) || 1,
        fromBasket: true,
      }
    : null;
}

/**
 * Lets a basket run out of time. The hold is five minutes, so the clock is pushed
 * past its deadline and the site's own sweeper is run: the rows end up exactly as
 * they would for somebody who walked away and came back.
 */
async function timeoutBasket(connection, person) {
  const asked = await requestSomething(connection, person, { send: false });

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

/**
 * The owner's side of a request: answers something waiting on this person's own items,
 * either sending part or all of it or saying there was nothing to send. Without this
 * every simulated request stayed pending for ever, so a requester's history never showed
 * a handover and the database only ever held asks nobody had touched.
 *
 * It goes through the same store function the signed-in list uses, oldest ask first, so
 * the copies it sends leave the free count exactly as a real answer would.
 */
async function answerRequest(connection, person) {
  const [rows] = await connection.execute(
    `SELECT id, item_name, requester_account_name, quantity, quantity_requested
       FROM itemshare_requests
      WHERE status = 'pending' AND owner_account_name = ?
      ORDER BY COALESCE(submitted_at, created_at) ASC, id ASC
      LIMIT 1`,
    [person.account]
  );
  const row = rows[0];

  if (!row) {
    return null;
  }

  const asked = Math.max(1, Number(row.quantity_requested) || Number(row.quantity) || 1);
  const roll = Math.random();
  // Sometimes nothing could be sent, sometimes part of it, sometimes all of it.
  const sent =
    roll < 0.25
      ? 0
      : roll < 0.65
        ? 1 + Math.floor(Math.random() * Math.max(1, asked - 1))
        : asked;
  const outcome = await recordOwnerGroupAnswer(connection, {
    accountNames: [person.account],
    anchorId: Number(row.id),
    sent,
  });

  if (!outcome || outcome.fulfilled + outcome.cancelled === 0) {
    return null;
  }

  return {
    person: person.account,
    requester: String(row.requester_account_name || 'someone'),
    item: String(row.item_name || 'an item'),
    asked,
    copies: outcome.copies,
    sentNothing: outcome.copies === 0,
  };
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

/**
 * Where a re-saved person's items are now, counted per place: "2 in Bank, 1 in Craft
 * Bag". Naming the first two places on their own could not be squared with the item
 * count beside it - three items and two places read like one had gone missing.
 */
function describeLocations(places) {
  const counts = new Map();

  for (const place of places) {
    counts.set(place, (counts.get(place) || 0) + 1);
  }

  return [...counts].map(([place, count]) => `${count} in ${place}`).join(', ');
}

/** Saves their file again: items move, stacks change, requests get re-settled. */
async function saveSomething(connection, person, guilds) {
  person.round += 1;
  const result = await savePerson(connection, person, guilds);

  return {
    person: person.account,
    items: result.itemCount,
    where: describeLocations(person.items.map((_, index) => locationFor(person, index))),
  };
}

// Where the site answers. BASE_URL is the address the site already publishes for its own
// links and sign-in redirects, so it is already right behind a proxy or on another port;
// --url overrides it for one run, and a missing scheme is filled in because "host:port"
// is what people type.
function siteBaseUrl() {
  const fromFlag = String(valueAfter('--url') || '').trim();
  const configured = String(process.env.BASE_URL || '').trim();
  const port = process.env.PORT || 3000;
  // BASE_URL wins over PORT, so a site moved to another port while BASE_URL still names
  // the old one is asked at the old address. The source comes back with the address so
  // the run says which one it used instead of leaving it to be guessed.
  const base = fromFlag || configured || `http://127.0.0.1:${port}`;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(base) ? base : `http://${base}`;

  return {
    url: withScheme.replace(/\/+$/, ''),
    source: fromFlag ? '--url' : configured ? 'BASE_URL' : `PORT ${port} (default)`,
  };
}

/**
 * The quieter way two processes hold different tokens while .env is correct on disk:
 * dotenv never overwrites a variable that is already in the environment, so a token
 * exported in this shell - or left over from an earlier export - wins over the file
 * without a word. The file is read here directly so the difference can be said out loud.
 */
function warnIfEnvIgnored(token) {
  let fromFile = '';

  try {
    fromFile = String(dotenv.parse(fs.readFileSync(ENV_PATH)).SIMULATE_TOKEN || '').trim();
  } catch {
    return;
  }

  if (fromFile && fromFile !== token) {
    warn(
      'the environment already had SIMULATE_TOKEN, so .env was ignored.\n' +
        `  This run sends ${tokenFingerprint(token)}, while ${ENV_PATH} holds ${tokenFingerprint(
          fromFile
        )}.\n` +
        '  Unset it for this run - env -u SIMULATE_TOKEN npm run simulate - or change the\n' +
        '  exported value to match the file.'
    );
  }
}

/**
 * What a refusal actually means, in terms a person can act on.
 *
 * The site compares the header with the token it read from its own `.env` when it
 * started, so there are only three answers and they look nothing alike:
 *
 *   403 with two fingerprints  that site holds a different token from this run.
 *   404, no token set         that site never loaded a token at all.
 *   404, no reason            no such route: not this site, or a version from before it.
 *
 * Both fingerprints are printed together, because that is the whole comparison: same
 * number, same token; different number, a second `.env` somewhere.
 */
function describeRefusal({ status, body, token }) {
  const mine = tokenFingerprint(token);
  const answer = body && typeof body === 'object' ? body : {};
  const reason = String(answer.reason || '');
  const theirs = String(answer.site || '');

  if (reason === 'token-mismatch') {
    return [
      `live pushes refused by ${SITE_URL} (address from ${SITE.source}): this run holds ${mine}, that site holds ${theirs}.`,
      '  Two different tokens. The site reads SIMULATE_TOKEN from its own .env at start-up,',
      '  so setting it on this machine changes nothing unless that same site was restarted',
      '  with the same value. It prints the fingerprint it holds as it boots.',
    ].join('\n');
  }

  if (reason === 'token-not-set') {
    return [
      `live pushes refused by ${SITE_URL} (address from ${SITE.source}): that site has no SIMULATE_TOKEN at all.`,
      '  It is reading a different .env from this run, or it started before the token was',
      '  added. Set SIMULATE_TOKEN where that site runs, then restart it.',
    ].join('\n');
  }

  if (status === 404) {
    return [
      `live pushes refused by ${SITE_URL} (HTTP 404, address from ${SITE.source}): nothing answers the simulate route there.`,
      '  Either that address is not this ItemShare (check BASE_URL or --url), or the site is',
      '  older than this check. The data still changes; open pages see it on their next',
      '  refresh.',
    ].join('\n');
  }

  return `live pushes refused by ${SITE_URL} (HTTP ${status}, address from ${SITE.source}); open pages were not told what changed.`;
}

/**
 * Says once, at start-up, whether the site will accept this run's announcements.
 *
 * Without it the first sign of trouble is a line per action, minutes in. This is the
 * same token check the nudge uses and it pushes nothing.
 */
async function checkLivePushes(token) {
  warnIfEnvIgnored(token);

  if (!token) {
    say(
      'live pushes off: set SIMULATE_TOKEN in .env and restart the site to have open pages refresh.'
    );
    return;
  }

  try {
    const response = await fetch(`${SITE_URL}/simulate/check`, {
      method: 'POST',
      headers: { 'x-itemshare-simulate': token },
    });

    if (response.ok) {
      say(
        `live pushes armed for ${SITE_URL} (token ${tokenFingerprint(
          token
        )}; the site holds the same one). Address from ${SITE.source}.`
      );
      return;
    }

    warn(
      describeRefusal({
        status: response.status,
        body: await response.json().catch(() => null),
        token,
      })
    );
  } catch (error) {
    warn(
      `could not reach ${SITE_URL} (address from ${SITE.source}; ${error.message}). The data still changes; open pages see it on their next refresh.`
    );
  }
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
      // Say what the site itself reported rather than guessing at it: its answer names the
      // token it holds, so both fingerprints sit next to each other in one line. Every
      // message names the address it asked, because "404" is as often the wrong site as
      // the wrong token.
      return describeRefusal({
        status: response.status,
        body: await response.json().catch(() => null),
        token,
      });
    }

    // Delivered, and that is the whole of it. How many pages were open is a detail the
    // site already prints on its own `Live:` line, because the site is the one holding
    // the connections; repeating it here put a second line under every action for a
    // number nobody acts on.
    return '';
  } catch (error) {
    return `live: could not reach the site on ${SITE_URL} (${error.message})`;
  }
}

// Ctrl+C stops after the action in flight and cuts the wait short, so stopping is
// immediate rather than "in up to thirty seconds".
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
// `--every 0` means no pause, and 0 is falsy: treating an absent flag and a zero the
// same way made the documented "0 runs with no pause" wait thirty seconds an action.
const everyGiven = valueAfter('--every');
const every = Math.max(
  0,
  everyGiven === '' ? (once ? 0 : 30000) : Number(everyGiven) || 0
);
const only = valueAfter('--only');
const removing = process.argv.includes('--reset');
const SITE = siteBaseUrl();
const SITE_URL = SITE.url;

// Before the database is touched, because a token that does not match is a configuration
// problem and this line is more useful on its own than buried under a connection error.
await checkLivePushes(String(process.env.SIMULATE_TOKEN || '').trim());

const config = readConfig();
let connection;

try {
  ({ connection } = await openDatabase(config));
} catch (error) {
  fail(describeConnectionFailure(error, config));
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

    say(`Removed ${PEOPLE.length} simulated people and everything they shared.`);
  } else {
    const mine = await realAccounts(connection);
    const guilds = await sharedGuilds(connection, mine);

    if (mine.length === 0) {
      fail(
        'No real ESO account found. Upload your ItemShareSavedVars.lua on the site first,\n' +
          'so the simulated people have a guildmate to share with.'
      );
      process.exitCode = 1;
    } else if (guilds.size === 0) {
      fail(
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
            ? ['request', 'send', 'answer', 'cancel', 'timeout']
            : ['request', 'send', 'answer', 'cancel', 'timeout', 'save'];

      say(
        `Simulating ${PEOPLE.length} people into ${guilds.size} guild${
          guilds.size === 1 ? '' : 's'
        } alongside ${mine.join(', ')}.`
      );
      say(
        `${only ? `Only ${only}` : 'A mix of asks, sends, answers, cancels, timeouts and re-saves'}${
          Number.isFinite(rounds)
            ? `, ${rounds} action${rounds === 1 ? '' : 's'}`
            : ', running until you stop it'
        }${every > 0 ? `, one every ${Math.round(every / 1000)}s` : ''}.`
      );

      if (!Number.isFinite(rounds) || rounds > 1) {
        say('press Ctrl+C to stop.');
      }

      let acted = 0;

      while (acted < rounds && !stopping) {
        acted += 1;

        const action = order[Math.floor(Math.random() * order.length)];
        const person = PEOPLE[Math.floor(Math.random() * PEOPLE.length)];
        let line = '';

        if (action === 'request') {
          const done = await requestSomething(connection, person);

          if (done && done.item) {
            line = `${done.person} asked ${done.owner} for ${done.quantity} x ${done.item}${
              done.sent ? ' and sent it straight away' : ' (still in their basket)'
            }`;
          }
        } else if (action === 'send') {
          const done = await sendBasket(connection, person);

          if (done) {
            line = `${done.person} sent ${done.sent} request${
              done.sent === 1 ? '' : 's'
            } (${done.copies} cop${done.copies === 1 ? 'y' : 'ies'}) for ${describeItems(
              done.items
            )} to ${done.owners.join(', ')} - the owner would be emailed`;
          }
        } else if (action === 'cancel') {
          // Only a basket row can be cancelled: once a request has been sent it stays in
          // the requester's history, so this says what was cancelled and that it had not
          // been sent yet.
          const done = await removeFromBasket(connection, person);

          if (done) {
            line = `${done.person} cancelled their request for ${done.quantity} x ${
              done.item
            } before it was sent`;
          }
        } else if (action === 'timeout') {
          const done = await timeoutBasket(connection, person);

          if (done) {
            line = `${done.person} let the basket clock run out, so ${describeItems([
              done.item,
            ])} went back to being available`;
          }
        } else if (action === 'answer') {
          // The owner's half of the conversation: an ask on their own items is sent, part
          // sent, or refused, so the requester's history shows an answer instead of an
          // ask nobody ever touched.
          const done = await answerRequest(connection, person);

          if (done) {
            line = done.sentNothing
              ? `${done.person} had nothing to send, so ${done.requester}'s request for ${describeItems(
                  [done.item]
                )} was cancelled`
              : `${done.person} sent ${done.copies} x ${done.item} to ${done.requester}`;
          }
        } else {
          const done = await saveSomething(connection, person, guilds);
          line = `${done.person} Inventory Refreshed - ${done.items} items: ${done.where}`;
        }

        if (!line) {
          // Nothing happened - no stock free, no basket to empty. An entry saying so would
          // put an action on the list that the site never saw, so nothing is printed and
          // nothing is announced.
          if (every > 0 && acted < rounds && !stopping) {
            await sleep(every);
          }
          continue;
        }

        say(`[${new Date().toLocaleTimeString()}] ${line}`);

        const live = await nudge(line);

        if (live) {
          say(live);
        }

        if (every > 0 && acted < rounds && !stopping) {
          await sleep(every);
        }
      }

      say(
        `Stopped after ${acted} action${acted === 1 ? '' : 's'}. ` +
          'Undo everything with: npm run simulate -- --reset'
      );
    }
  }
} finally {
  await connection.end();
}
