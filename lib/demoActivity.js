// The people in the demo copy, doing things while somebody watches.
//
// The demo database already holds several owners, so browsing works. What it cannot show
// on its own is the site being *used*: somebody asking the demo for an item, changing
// their stack, or handing over what was asked for. This module does one such thing per
// tick, as one of the cast in lib/demoCast.js, against the demo connection only.
//
// Nothing here can reach the real site. The caller passes the demo database's
// connection, and every helper is the same one the routes use, so the writes are shaped
// exactly like a visitor's - which is the point: the demo rehearses the real code paths.
// The only differences are that the addresses are invented, so no email is sent, and
// that the resulting push goes to the demo pages alone.

import {
  cancelOwnRequest,
  createRequest,
  getBasketRows,
  getOwnerRequests,
  getSharedItemsForViewer,
  recordOwnerAnswer,
  replaceAccounts,
  submitDrafts,
} from './store.js';
import { DEMO_ACCOUNT, DEMO_GUILD, DEMO_WORLD } from './demo.js';
import { DEMO_CAST, castAccount, castUserId } from './demoCast.js';

/** The four things a cast person can be caught doing. */
export const DEMO_ACTIVITY_SCENARIOS = ['answer', 'ask', 'cancel', 'refresh'];

/** How long a simulated basket holds its copies. Short, because it is a demo. */
const DEMO_HOLD_MINUTES = 5;

/**
 * How long to wait before the next action.
 *
 * The same idea `npm run simulate` uses: no fixed beat, because a copy that acts exactly
 * every fifteen seconds reads as a metronome rather than as people. The configured
 * interval is the average and each pause is drawn fresh after every action, between 60%
 * and 140% of it - 9s to 21s at the default - so the gap itself is never predictable.
 */
export function demoActivityPause(baseMs, random = Math.random) {
  const base = Math.max(0, Math.trunc(Number(baseMs) || 0));

  if (base === 0) {
    return 0;
  }

  const spread = Math.min(1, Math.max(0, Number(random()) || 0)) * 0.8;

  return Math.round(base * (0.6 + spread));
}

function pick(list, random) {
  return list[Math.min(list.length - 1, Math.max(0, Math.floor(random() * list.length)))];
}

/**
 * Which action a tick performs. Pure, so the rotation can be tested without a database:
 * every scenario must be reachable, and none may depend on an earlier one having run.
 */
export function pickScenario(random = Math.random) {
  return DEMO_ACTIVITY_SCENARIOS[
    Math.min(
      DEMO_ACTIVITY_SCENARIOS.length - 1,
      Math.max(0, Math.floor(random() * DEMO_ACTIVITY_SCENARIOS.length))
    )
  ];
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Answers a request the demo visitor sent to one of the cast.
 *
 * This is the other half of a request: the visitor asks, and a moment later one of the
 * guildmates hands it over, so the history says what a real answer looks like. The
 * answer goes through `recordOwnerAnswer`, the same call the owner's page and the email
 * link make, so what the demo sees is what a real handover writes.
 */
async function answerDemoRequest(connection, person, userId, demoAccount) {
  const pending = await getOwnerRequests(connection, [person.account], { limit: 50 });
  const row = pending.find((entry) =>
    (entry.requesters || []).includes(demoAccount)
  );

  if (!row) {
    return null;
  }

  const sentById = new Map(row.ids.map((id) => [Number(id), Number(row.asked) || 1]));
  const outcome = await recordOwnerAnswer(connection, {
    accountNames: [person.account],
    sentById,
  });

  if (outcome.fulfilled + outcome.cancelled === 0) {
    return null;
  }

  if (outcome.cancelled > 0 && outcome.fulfilled === 0) {
    return {
      kind: 'answer',
      summary: `${person.account} had nothing to send, so the request for ${row.item_name} was cancelled`,
    };
  }

  return {
    kind: 'answer',
    summary: `${person.account} sent ${plural(outcome.copies, 'copy', 'copies')} of ${
      row.item_name
    } to ${demoAccount} (the demo sends no email)`,
  };
}

/**
 * Asks the demo visitor for something they own.
 *
 * It is aimed at the demo's own shelf on purpose: the request then appears under Process
 * Requests on the demo's next page, which is the one part of the site a visitor cannot
 * reach by only browsing. Half the time the basket is sent, half the time it is left
 * waiting, so both states are seen.
 */
async function askTheDemo(connection, person, userId, { demoAccount, random }) {
  // A demo that is left open all afternoon must not pile up asks nobody will read, so a
  // person with two already waiting asks no further until one is answered.
  const [waiting] = await connection.execute(
    `SELECT COUNT(*) AS n FROM itemshare_requests
      WHERE requester_account_name = ? AND status = 'pending'`,
    [person.account]
  );

  if (Number(waiting && waiting[0] ? waiting[0].n : 0) >= 2) {
    return null;
  }

  const rows = await getSharedItemsForViewer(connection, [person.account], { limit: 300 });
  const mine = rows.filter(
    (row) => String(row.account_name) === demoAccount && Number(row.item_count) > 0
  );

  // Nothing of the demo's is visible - a copy filled before the demo shelf existed, for
  // instance - so ask anybody else rather than doing nothing at all.
  const candidates =
    mine.length > 0
      ? mine
      : rows.filter((row) => String(row.account_name) !== person.account);

  if (candidates.length === 0) {
    return null;
  }

  const item = pick(candidates, random);
  const free = Math.max(1, Number(item.item_count) || 1);
  const quantity = 1 + Math.floor(random() * Math.min(free, 2));

  let outcome;

  try {
    outcome = await createRequest(connection, {
      userId,
      requesterAccounts: [person.account],
      itemKind: 'inventory',
      itemId: Number(item.id),
      quantity,
      holdMinutes: DEMO_HOLD_MINUTES,
    });
  } catch (error) {
    // The last copy went between the read and the write, or the row moved on. Nothing
    // was reserved, so the next tick can try something else.
    return null;
  }

  const sent = random() < 0.5 ? await submitDrafts(connection, { userId }) : 0;

  return {
    kind: 'ask',
    summary:
      `${person.account} asked ${outcome.ownerAccountName} for ${plural(outcome.quantity, 'copy', 'copies')} ` +
      `of ${outcome.itemName}${sent > 0 ? '' : ' (still in their basket)'}`,
  };
}

/** Takes back something that was never sent, which is what the cancel button does. */
async function takeBackARequest(connection, person, userId) {
  const drafts = (await getBasketRows(connection, userId)).filter(
    (row) => row.status === 'draft'
  );

  if (drafts.length === 0) {
    return null;
  }

  const row = drafts[0];
  const outcome = await cancelOwnRequest(connection, {
    userId,
    requestId: Number(row.id),
    holdMinutes: DEMO_HOLD_MINUTES,
  });

  if (!outcome.cancelled) {
    return null;
  }

  return {
    kind: 'cancel',
    summary: `${person.account} took back their request for ${outcome.itemName} before sending`,
  };
}

/** Re-saves the file, the way the addon does on a timer: same shelf, new timestamps. */
async function refreshTheShelf(connection, person, userId, guild) {
  const guilds = new Map([[guild.id, guild.name]]);

  await replaceAccounts(
    connection,
    [
      castAccount(person, guilds, {
        platform: guild.platform,
        worldName: guild.worldName,
      }),
    ],
    { sourceFile: 'Demo activity', userId }
  );

  return {
    kind: 'refresh',
    summary: `${person.account} refreshed their file, so their items and timestamps were rewritten`,
  };
}

/**
 * Does one thing, as one of the demo's guildmates.
 *
 * The preferred order is: answer what the viewer asked for, then ask for something of
 * theirs, then cancel, then re-save. Every action falls through to the next when there is
 * nothing for it to do, so a quiet copy still produces movement rather than a tick that
 * writes nothing.
 *
 * @returns {Promise<{kind: string, summary: string}|null>} null when nothing happened
 */
export async function runDemoActivity(
  connection,
  {
    random = Math.random,
    cast = DEMO_CAST,
    demoAccount = DEMO_ACCOUNT,
    guild = { id: DEMO_GUILD.id, name: DEMO_GUILD.name, ...DEMO_WORLD },
  } = {}
) {
  if (!cast || cast.length === 0) {
    return null;
  }

  const person = pick(cast, random);
  const userId = Number(person.userId) || (await castUserId(connection, person));

  if (!userId) {
    return null;
  }

  const actions = {
    answer: () => answerDemoRequest(connection, person, userId, demoAccount),
    ask: () => askTheDemo(connection, person, userId, { demoAccount, random }),
    cancel: () => takeBackARequest(connection, person, userId),
    refresh: () => refreshTheShelf(connection, person, userId, guild),
  };

  const first = pickScenario(random);
  const order = [
    first,
    ...DEMO_ACTIVITY_SCENARIOS.filter((name) => name !== first),
  ];

  for (const name of order) {
    const outcome = await actions[name]();

    if (outcome) {
      return outcome;
    }
  }

  return null;
}

