#!/usr/bin/env node
// The command line that reopens expired requests, checked without a database.
//
// Two things are worth getting right before anything is written: which rows the command is
// willing to touch, and what it refuses to guess. The first is the flags - a half-typed
// `--id` or a bare run that would otherwise reopen everything - and the second is the
// per-row decision, which is driven here through a stand-in connection that answers like
// MariaDB and remembers every UPDATE it was handed.
//
//   npm run test:reopen-requests

import assert from 'node:assert/strict';

import { reopenExpiredRequests } from './lib/store.js';
import { formatReport, parseArguments } from './reopenRequests.js';

let total = 0;
let failures = 0;

function t(name, fn) {
  total += 1;

  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}

async function tAsync(name, fn) {
  total += 1;

  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}

/** One expired request row, as the join in the store hands it back. */
function expiredRow(over = {}) {
  return {
    id: 128,
    requester_user_id: 4,
    requester_account_name: '@Ghost',
    owner_account_name: '@Trader',
    item_kind: 'inventory',
    shared_item_id: 7,
    always_share_id: null,
    item_name: 'Briarheart Dagger',
    quantity: 2,
    quantity_requested: 2,
    inventory_id: 7,
    inventory_count: 5,
    offer_id: null,
    // The offer's own numbers, when the row is a standing offer: the file has to say what
    // is held beyond the reserve before a copy can be promised.
    offer_held: null,
    offer_reserve: 0,
    requester_email: 'ghost@example.com',
    ...over,
  };
}

/**
 * A connection that answers the three shapes of query the store sends and records the
 * writes, so a test can tell "reopened two copies" from "reopened nothing".
 */
function fakeConnection({ rows = [], reserved = {}, delivered = {} } = {}) {
  const updates = [];
  const queries = [];

  return {
    updates,
    queries,
    async execute(sql, params = []) {
      if (sql.trimStart().startsWith('UPDATE itemshare_requests')) {
        updates.push({ sql, params });
        return [{ affectedRows: 1 }, []];
      }

      if (sql.includes('AS reserved')) {
        queries.push({ kind: 'reserved', sql, params });
        return [[{ reserved: reserved[String(params[params.length - 1])] || 0 }], []];
      }

      if (sql.includes('AS delivered')) {
        queries.push({ kind: 'delivered', sql, params });
        return [[{ delivered: delivered[String(params[params.length - 1])] || 0 }], []];
      }

      if (sql.includes('FROM itemshare_requests r')) {
        queries.push({ kind: 'rows', sql, params });
        return [rows, []];
      }

      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  };
}

// ---------------------------------------------------------------- what the flags mean

t('a bare run refuses to touch anything', () => {
  const { options, problems } = parseArguments([]);

  assert.equal(options.dryRun, false);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /--all/);
});

t('the scope flags say which rows, and combine as an AND', () => {
  const { options, problems } = parseArguments([
    '--account',
    '@Ghost',
    '--item',
    'dagger',
    '--email',
    'Ghost@Example.com',
  ]);

  assert.deepEqual(problems, []);
  assert.equal(options.accountName, '@Ghost');
  assert.equal(options.itemText, 'dagger');
  assert.equal(options.requesterEmail, 'Ghost@Example.com');
});

t('--id takes one, several, or a comma-separated list', () => {
  const { options, problems } = parseArguments(['--id', '12', '--id', '13,14']);

  assert.deepEqual(problems, []);
  assert.deepEqual(options.ids, [12, 13, 14]);
});

t('--all is a scope on its own', () => {
  assert.deepEqual(parseArguments(['--all']).problems, []);
});

t('the destination is the basket unless --pending is given', () => {
  assert.equal(parseArguments(['--all']).options.target, 'basket');
  assert.equal(parseArguments(['--all', '--pending']).options.target, 'pending');
  assert.equal(parseArguments(['--all', '--pending', '--basket']).options.target, 'basket');
});

t('the hold can be set, and is bounded like the site bounds it', () => {
  assert.equal(parseArguments(['--all', '--minutes', '30']).options.minutes, 30);
  assert.match(parseArguments(['--all', '--minutes', '0']).problems[0], /1 to 120/);
  assert.match(parseArguments(['--all', '--minutes', '500']).problems[0], /1 to 120/);
});

t('a half-typed flag is a usage error, not an empty filter', () => {
  assert.match(parseArguments(['--email']).problems[0], /needs a value/);
  assert.match(parseArguments(['--id', 'abc']).problems[0], /not a request id/);
  assert.match(parseArguments(['--limit', '0']).problems[0], /above zero/);
  assert.match(parseArguments(['--nonsense']).problems[0], /unknown option/);
});

t('--dry-run and --help are read without a scope, because neither writes', () => {
  assert.equal(parseArguments(['--dry-run', '--all']).options.dryRun, true);
  assert.equal(parseArguments(['--help']).options.help, true);
  assert.deepEqual(parseArguments(['--help']).problems, []);
});

// ------------------------------------------------------ what the store is willing to do

await tAsync('only expired rows are ever looked at', async () => {
  const connection = fakeConnection({ rows: [] });

  await reopenExpiredRequests(connection, {});

  const select = connection.queries.find((query) => query.kind === 'rows');

  assert.match(select.sql, /r\.status = 'expired'/);
  assert.match(select.sql, /ORDER BY r\.id ASC/);
});

await tAsync('the filters reach the query, email lower-cased', async () => {
  const connection = fakeConnection({ rows: [] });

  await reopenExpiredRequests(connection, {
    requesterEmail: 'Ghost@Example.com',
    accountName: '@Ghost',
    itemText: 'dagger',
    ids: [12, 13],
  });

  const select = connection.queries.find((query) => query.kind === 'rows');

  assert.match(select.sql, /r\.id IN \(\?, \?\)/);
  assert.match(select.sql, /u\.email = \?/);
  assert.match(select.sql, /r\.requester_account_name = \?/);
  assert.match(select.sql, /r\.item_name LIKE \?/);
  assert.deepEqual(select.params, [12, 13, 'ghost@example.com', '@Ghost', '%dagger%']);
});

await tAsync('a row with room comes back as a draft holding what it held', async () => {
  const connection = fakeConnection({ rows: [expiredRow()] });
  const report = await reopenExpiredRequests(connection, { minutes: 30 });

  assert.equal(report.reopened.length, 1);
  assert.equal(report.reopened[0].quantity, 2);
  assert.equal(report.reopened[0].capped, false);

  assert.equal(connection.updates.length, 1);
  const [update] = connection.updates;

  assert.match(update.sql, /SET status = 'draft'/);
  assert.match(update.sql, /INTERVAL 30 MINUTE/);
  assert.match(update.sql, /closed_at = NULL/);
  assert.match(update.sql, /status_reason = ''/);
  assert.match(update.sql, /WHERE id = \? AND status = 'expired'/, 'a row that moved on is not touched');
  assert.deepEqual(update.params, [2, 2, 128]);
  assert.equal(report.target, 'basket', 'the basket is what happens unless asked otherwise');
});

await tAsync('--pending files it as a sent request, and emails nobody', async () => {
  const connection = fakeConnection({ rows: [expiredRow()] });
  const report = await reopenExpiredRequests(connection, { target: 'pending' });

  assert.equal(report.target, 'pending');
  assert.equal(report.reopened.length, 1);

  const [update] = connection.updates;

  assert.match(update.sql, /SET status = 'pending'/);
  assert.doesNotMatch(update.sql, /status = 'draft'/, 'not a draft: it is a real request now');
  assert.match(
    update.sql,
    /submitted_at = UTC_TIMESTAMP\(\)/,
    'the same moment submitDrafts records'
  );
  assert.match(update.sql, /expires_at = NULL/, 'a request waiting on an owner does not lapse');
  assert.doesNotMatch(update.sql, /INTERVAL/, 'there is no hold to time out');
  assert.match(update.sql, /WHERE id = \? AND status = 'expired'/);
  assert.deepEqual(update.params, [2, 2, 128]);
});

await tAsync('a pending dry run writes nothing either', async () => {
  const connection = fakeConnection({ rows: [expiredRow()] });
  const report = await reopenExpiredRequests(connection, { target: 'pending', dryRun: true });

  assert.equal(report.target, 'pending');
  assert.equal(report.reopened.length, 1);
  assert.equal(connection.updates.length, 0);
});

await tAsync('a row made pending is still checked against what is free', async () => {
  const connection = fakeConnection({ rows: [expiredRow()], reserved: { 7: 5 } });
  const report = await reopenExpiredRequests(connection, { target: 'pending' });

  assert.equal(report.reopened.length, 0);
  assert.match(report.skipped[0].reason, /spoken for/);
  assert.equal(connection.updates.length, 0);
});

await tAsync('a dry run reports the same rows and writes nothing', async () => {
  const connection = fakeConnection({ rows: [expiredRow()] });
  const report = await reopenExpiredRequests(connection, { dryRun: true });

  assert.equal(report.reopened.length, 1);
  assert.equal(report.dryRun, true);
  assert.equal(connection.updates.length, 0, 'no UPDATE at all');
});

await tAsync('a stack that is gone is skipped, never half-reopened', async () => {
  const connection = fakeConnection({
    rows: [expiredRow({ inventory_id: null, inventory_count: 0 })],
  });
  const report = await reopenExpiredRequests(connection, {});

  assert.equal(report.reopened.length, 0);
  assert.equal(report.skipped.length, 1);
  assert.match(report.skipped[0].reason, /no longer shared/);
  assert.equal(connection.updates.length, 0);
});

// An item that moved to another character, or was shared again, gets a new row id while
// the old one is pruned away. The owner is still offering it, so refusing here was wrong:
// the request follows the item by its key hash, the same way an open one does.
await tAsync('an item that moved to a new row is followed rather than refused', async () => {
  const connection = fakeConnection({
    rows: [
      expiredRow({ inventory_id: null, inventory_count: 0, replacement_id: 42, replacement_count: 3 }),
    ],
  });
  const report = await reopenExpiredRequests(connection, {});

  assert.equal(report.skipped.length, 0, 'the owner is still sharing it');
  assert.equal(report.reopened.length, 1);
  assert.equal(report.reopened[0].quantity, 2, 'the new row has the copies the request asked for');
  assert.equal(report.reopened[0].capped, false);
  assert.equal(connection.queries.filter((q) => q.kind === 'reserved').at(-1).params.at(-1), 42,
    'the copies held are counted against the row the item lives under now');

  const repointed = connection.updates.find((row) => /SET shared_item_id/.test(row.sql));
  assert.ok(repointed, 'the request is re-pointed at its item');
  assert.deepEqual(repointed.params, [42, 128]);
  assert.deepEqual(connection.updates[0].params, [2, 2, 128], 'the row itself is the one reopened');
});

await tAsync('a moved item with fewer copies is capped at what is there now', async () => {
  const connection = fakeConnection({
    rows: [expiredRow({ inventory_id: null, inventory_count: 0, replacement_id: 42, replacement_count: 1 })],
  });
  const report = await reopenExpiredRequests(connection, {});

  assert.equal(report.reopened[0].quantity, 1, 'one copy is what the new row holds');
  assert.equal(report.reopened[0].asked, 2);
  assert.equal(report.reopened[0].capped, true);
});

await tAsync('a moved item is not re-pointed by a dry run', async () => {
  const connection = fakeConnection({
    rows: [expiredRow({ inventory_id: null, inventory_count: 0, replacement_id: 42, replacement_count: 3 })],
  });
  const report = await reopenExpiredRequests(connection, { dryRun: true });

  assert.equal(report.reopened.length, 1);
  assert.equal(connection.updates.length, 0, 'nothing written, including the re-point');
});

await tAsync('every copy spoken for is skipped too', async () => {
  const connection = fakeConnection({ rows: [expiredRow()], reserved: { 7: 5 } });
  const report = await reopenExpiredRequests(connection, {});

  assert.equal(report.reopened.length, 0);
  assert.match(report.skipped[0].reason, /spoken for/);
  assert.equal(connection.updates.length, 0);
});

await tAsync('a partly free stack comes back with only the copies that are there', async () => {
  const connection = fakeConnection({
    rows: [expiredRow({ quantity: 5, quantity_requested: 5 })],
    reserved: { 7: 3 },
  });
  const report = await reopenExpiredRequests(connection, {});

  assert.equal(report.reopened[0].quantity, 2, 'five asked, two free');
  assert.equal(report.reopened[0].asked, 5);
  assert.equal(report.reopened[0].capped, true);
  assert.deepEqual(connection.updates[0].params, [2, 2, 128]);
});

await tAsync('a standing offer already asked for is skipped', async () => {
  const connection = fakeConnection({
    rows: [
      expiredRow({
        item_kind: 'offer',
        shared_item_id: null,
        inventory_id: null,
        always_share_id: 9,
        offer_id: 9,
        offer_held: 1,
        quantity: 1,
        item_name: 'Ring of the Twice-Born Star',
      }),
    ],
    reserved: { 9: 1 },
  });
  const report = await reopenExpiredRequests(connection, {});

  assert.equal(report.reopened.length, 0);
  assert.match(report.skipped[0].reason, /already been asked for/);
  assert.equal(connection.updates.length, 0);
});

await tAsync('a standing offer whose place holds more than the reserve comes back as one copy', async () => {
  const connection = fakeConnection({
    rows: [
      expiredRow({
        item_kind: 'offer',
        shared_item_id: null,
        inventory_id: null,
        always_share_id: 9,
        offer_id: 9,
        offer_held: 4,
        offer_reserve: 3,
        quantity: 3,
        item_name: 'Ring of the Twice-Born Star',
      }),
    ],
  });
  const report = await reopenExpiredRequests(connection, {});

  assert.equal(report.reopened[0].quantity, 1);
  assert.deepEqual(connection.updates[0].params, [1, 1, 128]);
});

await tAsync('a standing offer whose file wrote no count is not reopened as one copy', async () => {
  const connection = fakeConnection({
    rows: [
      expiredRow({
        item_kind: 'offer',
        shared_item_id: null,
        inventory_id: null,
        always_share_id: 9,
        offer_id: 9,
        offer_held: null,
        quantity: 1,
        item_name: 'Ring of the Twice-Born Star',
      }),
    ],
  });
  const report = await reopenExpiredRequests(connection, {});

  assert.equal(report.reopened.length, 0, 'nothing is promised from an unknown number');
  assert.match(report.skipped[0].reason, /does not say how many/);
  assert.equal(connection.updates.length, 0);
});

await tAsync('a standing offer with every copy kept back is not reopened either', async () => {
  const connection = fakeConnection({
    rows: [
      expiredRow({
        item_kind: 'offer',
        shared_item_id: null,
        inventory_id: null,
        always_share_id: 9,
        offer_id: 9,
        offer_held: 3,
        offer_reserve: 3,
        quantity: 1,
        item_name: 'Ring of the Twice-Born Star',
      }),
    ],
  });
  const report = await reopenExpiredRequests(connection, {});

  assert.equal(report.reopened.length, 0);
  assert.match(report.skipped[0].reason, /nothing left to hand over/);
  assert.equal(connection.updates.length, 0);
});

// ------------------------------------------------------------- what the operator reads

t('the report says what would happen, and what was refused', () => {
  const dry = formatReport({
    minutes: 5,
    dryRun: true,
    reopened: [
      {
        id: 128,
        itemName: 'Briarheart Dagger',
        quantity: 2,
        asked: 2,
        capped: false,
        requesterAccount: '@Ghost',
        ownerAccount: '@Trader',
      },
      {
        id: 129,
        itemName: 'Ancient Silk',
        quantity: 1,
        asked: 4,
        capped: true,
        requesterAccount: '@Ghost',
        ownerAccount: '@Trader',
      },
    ],
    skipped: [
      {
        id: 131,
        itemName: 'Hildune Secret Refuge',
        requesterAccount: '@Ghost',
        ownerAccount: '@Trader',
        reason: 'every copy is spoken for',
      },
    ],
  });
  const text = dry.join('\n');

  assert.match(text, /Hold: 5 minutes from now/);
  assert.match(text, /Would reopen 2 requests \(nothing written\)/);
  assert.match(text, /#128 {2}2 x Briarheart Dagger {2}@Ghost -> @Trader/);
  assert.match(text, /#129 {2}1 of 4 x Ancient Silk/, 'the capped row says what was asked');
  assert.match(text, /only what was free/);
  assert.match(text, /Skipped 1 request:/);
  assert.match(text, /every copy is spoken for/);
  assert.match(text, /Nothing was written/);
});

t('a run that reopened says so, and that no owner was told', () => {
  const text = formatReport({
    minutes: 1,
    dryRun: false,
    reopened: [
      {
        id: 7,
        itemName: 'Briarheart Dagger',
        quantity: 1,
        asked: 1,
        capped: false,
        requesterAccount: '@Ghost',
        ownerAccount: '@Trader',
      },
    ],
    skipped: [],
  }).join('\n');

  assert.match(text, /Hold: 1 minute from now/, 'one minute is not "1 minutes"');
  assert.match(text, /^Reopened 1 request:/m);
  assert.match(text, /Nothing has been sent to an owner/);
  assert.match(text, /Send requests is what asks/);
});

t('a pending run says the owner was not emailed', () => {
  const text = formatReport({
    target: 'pending',
    minutes: 5,
    dryRun: false,
    reopened: [
      {
        id: 128,
        itemName: 'Briarheart Dagger',
        quantity: 2,
        asked: 2,
        capped: false,
        requesterAccount: '@Ghost',
        ownerAccount: '@Trader',
      },
    ],
    skipped: [],
  }).join('\n');

  assert.match(text, /Destination: pending/);
  assert.match(text, /the owner is not emailed/);
  assert.match(text, /No email was sent/);
  assert.match(text, /waiting in its owner's list/);
  assert.doesNotMatch(text, /back in the basket/);
});

t('a run that matched nothing says that rather than printing an empty list', () => {
  const text = formatReport({ minutes: 5, dryRun: false, reopened: [], skipped: [] }).join('\n');

  assert.match(text, /Nothing to reopen: no expired request matched/);
});

console.log(`\n${total - failures}/${total} passed`);

process.exit(failures ? 1 : 0);
