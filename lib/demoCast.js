// The demo's other people.
//
// A visitor who is the only owner in the copy has nothing to ask for: every row on the
// shelf is theirs, so the Request tab is a mirror of their own bag and the request
// dialog can only refuse. These accounts are the guildmates the demo otherwise lacks.
// They share into the same guild the demo person is in, so their items are visible to
// her and hers are visible to them - which is what makes requesting, reserving and
// answering possible at all.
//
// They are written the way seedDemo.js writes @DemoTrader: an ESO account that shares
// into a guild without being a real person's sign-in. They exist only in the demo
// database, built from the same catalogue and thrown away with it, so nothing here can
// put an item on the real site.

import { DEMO_EXPIRE_DAYS, OFFERS, ITEMS, buildItem, buildOffer } from './demoItems.js';
import { staggerFirstSeen } from './itemAges.js';
import { replaceAccounts } from './store.js';

/** The identity provider these people are recognised by between runs. */
export const DEMO_CAST_PROVIDER = 'demo-cast';

/**
 * Who the demo's guildmates are.
 *
 * Three people, each with a slice of the catalogue rather than all of it, so the list has
 * several owners and several kinds of item - and so an item asked for from one person is
 * not also owned by the next. `items` and `offers` are indexes into lib/demoItems.js.
 */
export const DEMO_CAST = [
  { account: '@NightMarket', character: 'Sells-At-Dawn', items: [0, 3, 5, 8], offers: [0] },
  { account: '@QuietSmith', character: 'Hums-While-Working', items: [1, 2, 6], offers: [1] },
  { account: '@AetherCartel', character: 'Trades-In-Rumours', items: [4, 7], offers: [2] },
];

/**
 * The address on a cast person's row.
 *
 * A documentation-style domain that cannot receive mail, like the demo person's own
 * address, so a copy of the site can never mail anybody even if a route were reached
 * that should not be.
 */
export function castEmail(account) {
  const local = String(account)
    .replace(/^@/, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();

  return `${local || 'someone'}@demo-cast.invalid`;
}

/** The catalogue rows one cast person shares, resolved from their indexes. */
export function castCatalogue(person) {
  const items = (person.items || []).map((index) => ITEMS[index]).filter(Boolean);
  const offers = (person.offers || []).map((index) => OFFERS[index]).filter(Boolean);

  return { items, offers };
}

/**
 * One cast person in the shape `replaceAccounts` takes - the same shape an upload
 * builds, so everything downstream treats their items like anybody else's.
 */
export function castAccount(
  person,
  guilds,
  {
    platform = 0,
    worldName = '',
    accountName = person.account,
    characterName = person.character,
  } = {}
) {
  const { items, offers } = castCatalogue(person);
  const guildIds = [...guilds.keys()];

  return {
    accountName,
    characterName,
    items: items.map((spec, index) =>
      buildItem(spec, index, guildIds, { accountName, characterName })
    ),
    alwaysShare: offers.map((spec, index) =>
      buildOffer(spec, index, guildIds, { accountName, characterName })
    ),
    guilds,
    addonVersion: 'demo',
    platform,
    worldName,
    // The guildmates share under the same window, so the pill is not only ever on the
    // visitor's own rows.
    expireDays: DEMO_EXPIRE_DAYS,
  };
}

/**
 * The person row behind one cast account, made once.
 *
 * They need a real `itemshare_users` row because a request is addressed to a person, not
 * to an account: without an id there is nobody to put in the basket. The identity row is
 * what makes them the same person on the next call instead of a new one.
 */
export async function castUserId(connection, person) {
  const [known] = await connection.execute(
    `SELECT user_id FROM itemshare_user_identities
      WHERE provider = ? AND provider_user_id = ?
      LIMIT 1`,
    [DEMO_CAST_PROVIDER, person.account]
  );

  if (known[0]) {
    return Number(known[0].user_id);
  }

  const [created] = await connection.execute(
    'INSERT INTO itemshare_users (display_name, email, email_verified) VALUES (?, ?, 0)',
    [person.character, castEmail(person.account)]
  );

  const userId = Number(created.insertId);

  await connection.execute(
    `INSERT INTO itemshare_user_identities (provider, provider_user_id, user_id)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
    [DEMO_CAST_PROVIDER, person.account, userId]
  );

  return userId;
}

/**
 * Makes sure the demo guild has other people sharing into it.
 *
 * Called once per boot, right after the demo person's own shelf is written, and again
 * when a demo signs in on a database that was restored without them. Idempotent: a cast
 * account that already shares something is left exactly as it is, so a restart does not
 * undo what a visitor did to their stacks.
 *
 * @returns {Promise<{seeded: string[], kept: string[]}>}
 */
export async function ensureDemoCast(
  connection,
  {
    guildId,
    guildName = '',
    platform = 0,
    worldName = '',
    source = 'Demo cast',
    cast = DEMO_CAST,
  } = {}
) {
  const id = Number(guildId) || 0;

  if (id === 0) {
    return { seeded: [], kept: [] };
  }

  const guilds = new Map([[id, guildName]]);
  const seeded = [];
  const kept = [];

  for (const person of cast) {
    const userId = await castUserId(connection, person);
    // Remembered on the catalogue so the activity loop knows which person row to act
    // as without a lookup per tick.
    person.userId = userId;

    const [counted] = await connection.execute(
      'SELECT COUNT(*) AS n FROM itemshare_shared_items WHERE account_name = ?',
      [person.account]
    );

    if (Number(counted && counted[0] ? counted[0].n : 0) > 0) {
      kept.push(person.account);
      continue;
    }

    await replaceAccounts(
      connection,
      [castAccount(person, guilds, { platform, worldName })],
      { sourceFile: source, userId }
    );

    // A guildmate whose whole shelf appeared in the same second reads as seeded rather
    // than lived in, so their new rows get a spread of first-offered dates. Anything
    // they still have later keeps the date it was given here.
    await staggerFirstSeen(connection, { accountNames: [person.account] });

    seeded.push(person.account);
  }

  return { seeded, kept };
}
