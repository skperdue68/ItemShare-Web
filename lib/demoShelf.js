// Keeps the demo's shelves full.
//
// The demo is a shared copy that a visitor may browse for a long time, with the cast
// asking for the demo's things while they watch. Every ask reserves copies, and a row
// whose last copy is reserved is dropped from the page after a few seconds - the same
// rule a real owner's row follows. That is right for one visitor and wrong for the next:
// a demo left open all afternoon would slowly empty, and the person who arrives after
// them would find a half-empty shelf and nothing left to ask for.
//
// So this module does two things, both against the demo connection only:
//
//   1. lets go of asks the cast made that nobody was ever going to answer, because the
//      machine asked and then walked away from the request;
//   2. re-saves every demo account's file, which is what an owner's next upload does:
//      the shelf is full again, copies "mailed" since the last file are no longer
//      subtracted, and every row keeps the first-offered date it already had.
//
// Nothing here touches a real database, and a visitor's own requests are left alone -
// only the cast's abandoned asks are released.

import { DEMO_EXPIRE_DAYS, ITEMS, OFFERS, buildItem, buildOffer } from './demoItems.js';
import { DEMO_ACCOUNT, DEMO_GUILD, DEMO_WORLD } from './demo.js';
import { DEMO_CAST, castAccount } from './demoCast.js';
import { staggerFirstSeen } from './itemAges.js';
import { replaceAccounts } from './store.js';

/**
 * How long an ask from the cast is left standing before the demo takes it back.
 *
 * Long enough that the visitor can watch their request be answered - the activity loop
 * answers within a tick or two - and short enough that a machine which asked and never
 * followed through cannot hold a shelf's last copy for the rest of the afternoon.
 */
export const DEMO_ASK_TTL_MS = 2 * 60 * 1000;

/** How often the shelf is topped up. A minute is invisible to a visitor and cheap here. */
export const DEMO_RESTOCK_MS = 60 * 1000;

const RELEASE_REASON =
  'The demo let this go, so the shelves stay full for the next visitor.';

/**
 * The cast's own asks that have stood too long.
 *
 * The guard is on the requester: an ask the visitor sent is theirs to cancel, and the
 * activity answers those rather than dropping them. `submitted_at` is the send time, so
 * a basket still being filled is not touched - it has its own hold to lapse.
 */
export function abandonedAsksSql(accountCount = 1) {
  const placeholders = Array.from({ length: Math.max(1, accountCount) }, () => '?').join(', ');

  return `UPDATE itemshare_requests
             SET status = 'cancelled',
                 status_reason = ?,
                 closed_at = CURRENT_TIMESTAMP,
                 email_token_hash = '',
                 email_token_expires_at = NULL
           WHERE status = 'pending'
             AND requester_account_name IN (${placeholders})
             AND submitted_at IS NOT NULL
             AND submitted_at < ?`;
}

/** @returns {Promise<number>} how many asks the demo took back */
export async function releaseAbandonedAsks(
  connection,
  {
    castAccounts = DEMO_CAST.map((person) => person.account),
    olderThanMs = DEMO_ASK_TTL_MS,
    now = Date.now(),
  } = {}
) {
  const accounts = [...new Set((castAccounts || []).filter(Boolean))];

  if (accounts.length === 0) {
    return 0;
  }

  const cutoff = new Date(now - Math.max(0, Number(olderThanMs) || 0));
  const [result] = await connection.execute(abandonedAsksSql(accounts.length), [
    RELEASE_REASON,
    ...accounts,
    cutoff,
  ]);

  return Number((result && result.affectedRows) || 0);
}

/**
 * Re-saves every demo account's file, the way their next upload would.
 *
 * `replaceAccounts` refreshes each row where it stands, so item ids, request history and
 * first-offered dates all survive; what changes is that the count is the catalogue's again
 * and copies handed over since the previous upload are no longer subtracted.
 *
 * @returns {Promise<number>} how many accounts were written
 */
export async function restockDemoShelf(
  connection,
  {
    guild = {
      id: DEMO_GUILD.id,
      name: DEMO_GUILD.name,
      platform: DEMO_WORLD.platform,
      worldName: DEMO_WORLD.worldName,
    },
    cast = DEMO_CAST,
    items = ITEMS,
    offers = OFFERS,
  } = {}
) {
  const guilds = new Map([[guild.id, guild.name]]);
  const platform = Number(guild.platform) || 0;
  const worldName = String(guild.worldName || '');
  const guildIds = [guild.id];

  const accounts = [
    {
      accountName: DEMO_ACCOUNT,
      items: items.map((spec, index) =>
        buildItem(spec, index, guildIds, { accountName: DEMO_ACCOUNT })
      ),
      alwaysShare: offers.map((spec, index) =>
        buildOffer(spec, index, guildIds, { accountName: DEMO_ACCOUNT })
      ),
      guilds,
      addonVersion: 'demo',
      platform,
      worldName,
      // A restock re-saves the file, so the window travels with it; without it the demo
      // would lose its LAST CHANCE rows a minute after the first visitor arrived.
      expireDays: DEMO_EXPIRE_DAYS,
    },
    ...cast.map((person) => castAccount(person, guilds, { platform, worldName })),
  ];

  await replaceAccounts(connection, accounts, { sourceFile: 'Demo restock' });
  await staggerFirstSeen(connection, {
    accountNames: accounts.map((account) => account.accountName),
  });

  return accounts.length;
}

/** Whether enough time has passed since the last top-up to justify another one. */
export function shouldRestock(lastAt, now = Date.now(), interval = DEMO_RESTOCK_MS) {
  const last = Number(lastAt) || 0;

  return last === 0 || now - last >= Math.max(0, Number(interval) || 0);
}

let lastRestockAt = 0;
let restocking = null;

/**
 * Top up if it is time to. The in-flight promise is shared, so two pages arriving
 * together cannot write the same shelves twice.
 *
 * @returns {Promise<{released: number, accounts: number}|null>} null when nothing ran
 */
export async function keepDemoShelfFull(connection, { now = Date.now(), interval } = {}) {
  if (!shouldRestock(lastRestockAt, now, interval)) {
    return restocking ? { released: 0, accounts: 0 } : null;
  }

  if (restocking) {
    return restocking;
  }

  lastRestockAt = now;

  restocking = (async () => {
    try {
      const released = await releaseAbandonedAsks(connection, { now });
      const accounts = await restockDemoShelf(connection);

      return { released, accounts };
    } finally {
      restocking = null;
    }
  })();

  return restocking;
}

/** Only for tests and for a demo database that has just been rebuilt. */
export function forgetRestockClock() {
  lastRestockAt = 0;
  restocking = null;
}
