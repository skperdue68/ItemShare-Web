#!/usr/bin/env node
// Database-backed test of one request's whole life: the upload that shares a stack, the
// ask, the send, the owner's answer, and the next upload. It runs the real migrations
// (including 019) and the real store functions, so a change in either fails here rather
// than in somebody's guild.
//
//   npm run test:fulfillment
//
// Settings are read exactly as the site reads them - MARIADB_HOST, MARIADB_PORT,
// MARIADB_USER, MARIADB_PASSWORD, ITEMSHARE_DATABASE - and the database is DROPPED
// before it is rebuilt, which is why the name has to end in _test.
//
// The point of the numbers below is the arithmetic that was wrong before: copies that
// were mailed must leave the free count at once, and must not be taken off again once
// the owner's next upload has left them out.

import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';

import { openDatabase, readConfig } from './lib/database.js';
import {
  createRequest,
  getFulfillForm,
  getOwnerRequests,
  getRequesterRequests,
  getSharedItemsForViewer,
  issueRequestEmailToken,
  linkAccountToUser,
  recordFulfillment,
  recordOwnerAnswer,
  recordOwnerGroupAnswer,
  replaceAccounts,
  submitDrafts,
} from './lib/store.js';

process.env.ITEMSHARE_DATABASE = process.env.ITEMSHARE_DATABASE || 'itemshare_test';

const config = readConfig();

if (!config.database.endsWith('_test')) {
  console.error(
    `Refusing to run: ITEMSHARE_DATABASE is "${config.database}" and this test drops it.\n` +
      'Use a name ending in _test, for example ITEMSHARE_DATABASE=itemshare_test.'
  );
  process.exit(2);
}

const OWNER = '@TestOwner';
const ASKER = '@TestAsker';
const GUILD = 9001;
const ITEM = 'Briarheart Dagger';
// A second name, so one message can carry two rows that are answered separately.
const SECOND = 'Soul Gem';

let checks = 0;

function ok(label, actual, expected) {
  assert.deepEqual(actual, expected, label);
  checks += 1;
  console.log(`  ok  ${label}${expected === undefined ? '' : ` - ${JSON.stringify(actual)}`}`);
}

// What the addon writes for one item. Only the fields the store reads are meaningful;
// the rest are here so a new column cannot silently shift the row.
function itemFor(accountName, itemName, itemCount) {
  // Keyed by name, so a file with two names makes two shared rows rather than one that
  // overwrites the other.
  const slug = itemName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  return {
    accountName,
    characterName: 'Tester',
    itemKey: `test-key:${slug}`,
    itemLink: '',
    itemName,
    itemId: 12345 + slug.length,
    icon: '',
    itemType: 1,
    itemTypeName: 'Miscellaneous',
    quality: 3,
    qualityName: 'Superior',
    trait: '',
    traitType: '',
    apparelSlot: '',
    equipType: '',
    apparelWeight: '',
    armorType: '',
    weaponType: '',
    weaponHandedness: '',
    setName: '',
    enchantName: '',
    styleName: '',
    requiredLevel: 0,
    requiredCp: 0,
    flavorText: null,
    esoData: null,
    furnitureDataId: 0,
    locationKey: 'inventory',
    locationLabel: 'Inventory',
    itemCount,
    heldQuantity: 0,
    reserveQuantity: 0,
    firstDumpedAt: 0,
    lastDumpedAt: 0,
    guildIds: [GUILD],
  };
}

/** Writes this person's whole file again, from a list of `{ name, count }`. */
async function uploadItems(connection, accountName, entries) {
  const [result] = await replaceAccounts(
    connection,
    [
      {
        accountName,
        items: entries.map(({ name, count }) => itemFor(accountName, name, count)),
        alwaysShare: [],
        guilds: new Map([[GUILD, 'Test Guild']]),
      },
    ],
    { sourceFile: 'test.lua' }
  );

  return result;
}

async function upload(connection, accountName, itemCount) {
  return uploadItems(
    connection,
    accountName,
    itemCount > 0 ? [{ name: ITEM, count: itemCount }] : []
  );
}

/** Backdates an upload, so "was this mailed after the file arrived?" has one answer. */
async function ageUpload(connection, uploadId, minutes) {
  const safeMinutes = Math.max(1, Math.trunc(Number(minutes) || 1));
  await connection.execute(
    `UPDATE itemshare_uploads SET uploaded_at = (NOW() - INTERVAL ${safeMinutes} MINUTE) WHERE id = ?`,
    [uploadId]
  );
}

/** What the Request list would show, taken from the query the page itself uses. */
async function availability(connection) {
  const rows = await getSharedItemsForViewer(connection, [ASKER]);
  const row = rows.find((entry) => entry.item_name === ITEM);

  if (!row) {
    return null;
  }

  const total = Number(row.item_count) || 0;
  const reserved = Number(row.reserved) || 0;
  const delivered = Number(row.delivered) || 0;

  return { total, reserved, delivered, free: total - reserved - delivered };
}

async function askFor(connection, userId, sharedItemId, quantity) {
  const created = await createRequest(connection, {
    userId,
    requesterAccounts: [ASKER],
    ownAccounts: [ASKER],
    itemKind: 'inventory',
    itemId: sharedItemId,
    quantity,
    holdMinutes: 5,
  });

  return Number(created.id);
}

let connection;

try {
  const admin = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${config.database}\``);
  await admin.end();

  ({ connection } = await openDatabase(config));
} catch (error) {
  console.error(
    `Cannot reach MariaDB at ${config.host}:${config.port} as ${config.user}: ${error.message}\n` +
      'This test needs a real MariaDB. Set MARIADB_HOST / MARIADB_USER / MARIADB_PASSWORD and try again.'
  );
  process.exit(1);
}

try {
  const [ledger] = await connection.execute(
    'SELECT filename FROM itemshare_schema_migrations ORDER BY filename'
  );
  const applied = ledger.map((row) => row.filename);
  ok('migration 019 is applied', applied.includes('019_itemshare_request_fulfillment.sql'), true);

  const [ownerUser] = await connection.execute(
    'INSERT INTO itemshare_users (display_name, email, email_verified) VALUES (?, ?, 1)',
    ['Owner', 'owner@test.invalid']
  );
  const [askerUser] = await connection.execute(
    'INSERT INTO itemshare_users (display_name, email, email_verified) VALUES (?, ?, 1)',
    ['Asker', 'asker@test.invalid']
  );

  const ownerId = Number(ownerUser.insertId);
  const askerId = Number(askerUser.insertId);

  await linkAccountToUser(connection, { accountName: OWNER, userId: ownerId });
  await linkAccountToUser(connection, { accountName: ASKER, userId: askerId });

  console.log('\n1. The owner shares ten, and the file arrived ten minutes ago');
  const firstUpload = await upload(connection, OWNER, 10);
  await upload(connection, ASKER, 0);
  await ageUpload(connection, firstUpload.uploadId, 10);

  ok('a fresh stack is all free', await availability(connection), {
    total: 10,
    reserved: 0,
    delivered: 0,
    free: 10,
  });

  const [shared] = (
    await getSharedItemsForViewer(connection, [ASKER])
  ).filter((row) => row.item_name === ITEM);
  const sharedItemId = Number(shared.id);

  console.log('\n2. The ask holds its copies before it is even sent');
  const requestId = await askFor(connection, askerId, sharedItemId, 3);
  ok('a basket draft holds three', await availability(connection), {
    total: 10,
    reserved: 3,
    delivered: 0,
    free: 7,
  });

  console.log('\n3. Sending it turns the draft into a promise');
  ok('one request left the basket', await submitDrafts(connection, { userId: askerId }), 1);

  const [pending] = await connection.execute(
    'SELECT status, quantity, quantity_requested FROM itemshare_requests WHERE id = ?',
    [requestId]
  );
  ok('it is waiting on the owner', pending[0].status, 'pending');
  ok('outstanding and original are the same number', [
    Number(pending[0].quantity),
    Number(pending[0].quantity_requested),
  ], [3, 3]);
  ok('a sent request keeps holding its copies', await availability(connection), {
    total: 10,
    reserved: 3,
    delivered: 0,
    free: 7,
  });

  console.log('\n4. The owner answers two of the three from the email');
  const token = await issueRequestEmailToken(connection, [requestId]);
  ok('a token was issued', typeof token === 'string' && token.length === 64, true);

  const form = await getFulfillForm(connection, token);
  ok(
    'the form carries the row and the number asked for',
    form ? form.rows.map((row) => [Number(row.id), row.asked]) : null,
    [[requestId, 3]]
  );

  const answered = await recordFulfillment(connection, {
    token,
    sentById: new Map([[requestId, 2]]),
  });
  ok('two copies were recorded as sent', answered ? [
    answered.fulfilled,
    answered.cancelled,
    answered.copies,
  ] : null, [1, 0, 2]);

  const [answeredRow] = await connection.execute(
    'SELECT status, quantity, quantity_requested, fulfilled_at, closed_at FROM itemshare_requests WHERE id = ?',
    [requestId]
  );
  ok('the row is closed and stamped', [
    answeredRow[0].status,
    answeredRow[0].fulfilled_at instanceof Date,
    answeredRow[0].closed_at instanceof Date,
  ], ['fulfilled', true, true]);
  ok('the ask survives the short handover', [
    Number(answeredRow[0].quantity),
    Number(answeredRow[0].quantity_requested),
  ], [2, 3]);

  ok('mailed copies leave the free count at once', await availability(connection), {
    total: 10,
    reserved: 0,
    delivered: 2,
    free: 8,
  });

  const history = await getRequesterRequests(connection, askerId);
  ok('the requester reads what was handed over', history.map((row) => [
    row.status,
    Number(row.quantity),
    Number(row.quantity_requested),
    row.status_reason,
  ]), [['fulfilled', 2, 3, '2 of 3 sent']]);

  ok(
    'answering the same form again changes nothing',
    await recordFulfillment(connection, { token, sentById: new Map([[requestId, 3]]) }),
    null
  );

  console.log('\n5. The next upload carries the smaller stack, and nothing is counted twice');
  await upload(connection, OWNER, 8);
  ok('eight left in the bag, eight free', await availability(connection), {
    total: 8,
    reserved: 0,
    delivered: 0,
    free: 8,
  });
  ok('the delivered copies are gone from the count, not subtracted again', (
    await availability(connection)
  ).delivered, 0);
  ok('the owner has nothing left to answer', (await getOwnerRequests(connection, [OWNER])).length, 0);

  // One tick, so the next answer is unambiguously newer than the upload above - the
  // delivered/since-upload comparison is whole seconds.
  await new Promise((resolve) => setTimeout(resolve, 1100));

  console.log('\n6. The owner answers on the site instead, and sends nothing');
  const cancelledId = await askFor(connection, askerId, sharedItemId, 4);
  await submitDrafts(connection, { userId: askerId });

  ok('the owner page lists it', (await getOwnerRequests(connection, [OWNER])).map(
    (row) => Number(row.id)
  ), [cancelledId]);

  const siteToken = await issueRequestEmailToken(connection, [cancelledId]);
  const cancelled = await recordOwnerAnswer(connection, {
    accountNames: [OWNER],
    sentById: new Map([[cancelledId, 0]]),
  });
  ok('nothing sent cancels the request', [cancelled.fulfilled, cancelled.cancelled], [0, 1]);
  ok('a cancellation puts the copies straight back', await availability(connection), {
    total: 8,
    reserved: 0,
    delivered: 0,
    free: 8,
  });
  ok('answering on the site kills the email link too', await getFulfillForm(connection, siteToken), null);
  ok('it leaves the owner page', (await getOwnerRequests(connection, [OWNER])).length, 0);

  const cancelledHistory = await getRequesterRequests(connection, askerId);
  ok('the requester sees it cancelled', cancelledHistory[0].status, 'cancelled');
  ok(
    'with the owner\'s reason on it',
    String(cancelledHistory[0].status_reason).includes('nothing to send'),
    true
  );

  console.log('\n7. A number larger than the ask is clamped, and delivered copies still count');
  const clampId = await askFor(connection, askerId, sharedItemId, 5);
  await submitDrafts(connection, { userId: askerId });
  ok('five held means three free of eight', await availability(connection), {
    total: 8,
    reserved: 5,
    delivered: 0,
    free: 3,
  });

  const clampToken = await issueRequestEmailToken(connection, [clampId]);
  const clamped = await recordFulfillment(connection, {
    token: clampToken,
    sentById: new Map([[clampId, 99]]),
  });
  ok('ninety-nine becomes five', clamped ? clamped.rows.map((row) => row.sent) : null, [5]);
  ok('five mailed against an eight stack leaves three', await availability(connection), {
    total: 8,
    reserved: 0,
    delivered: 5,
    free: 3,
  });

  console.log('\n8. The following upload settles it for good');
  await upload(connection, OWNER, 3);
  ok('three in the bag, three free, nothing delivered twice', await availability(connection), {
    total: 3,
    reserved: 0,
    delivered: 0,
    free: 3,
  });

  console.log('\n9. One message, two rows, answered one row at a time');
  // Not backdated, unlike stage 1: the copies handed over in stages 4 and 7 happened
  // before this file was written, so this upload's own count already leaves them out and
  // they must not be subtracted again. Answering waits a tick instead, because
  // "mailed after the upload" is compared in whole seconds.
  await uploadItems(connection, OWNER, [
    { name: ITEM, count: 10 },
    { name: SECOND, count: 5 },
  ]);

  const sharedRows = await getSharedItemsForViewer(connection, [ASKER]);
  const firstItemId = Number(sharedRows.find((row) => row.item_name === ITEM).id);
  const secondItemId = Number(sharedRows.find((row) => row.item_name === SECOND).id);

  const firstRow = await askFor(connection, askerId, firstItemId, 2);
  await submitDrafts(connection, { userId: askerId });
  const secondRow = await askFor(connection, askerId, secondItemId, 1);
  await submitDrafts(connection, { userId: askerId });

  const bothAdded = [firstRow, secondRow].sort((a, b) => a - b);
  ok(
    'both asks are waiting, as separate rows',
    (await getOwnerRequests(connection, [OWNER]))
      .map((row) => Number(row.id))
      .sort((a, b) => a - b),
    bothAdded
  );

  const oneToken = await issueRequestEmailToken(connection, [firstRow, secondRow]);
  const before = await getFulfillForm(connection, oneToken);
  ok(
    'one message carries both rows',
    before ? before.rows.map((row) => Number(row.id)).sort((a, b) => a - b) : null,
    bothAdded
  );

  await new Promise((resolve) => setTimeout(resolve, 1100));

  const partial = await recordFulfillment(connection, {
    token: oneToken,
    sentById: new Map([[firstRow, 2]]),
  });
  ok(
    'only the row that was saved is recorded',
    partial ? [partial.fulfilled, partial.cancelled, partial.copies] : null,
    [1, 0, 2]
  );

  const [savedRows] = await connection.execute(
    'SELECT id, status, quantity, quantity_requested FROM itemshare_requests WHERE id IN (?, ?)',
    [firstRow, secondRow]
  );
  const byId = new Map(savedRows.map((row) => [Number(row.id), row]));
  ok('the saved row is closed', byId.get(firstRow).status, 'fulfilled');
  ok(
    'the other row is untouched and still pending',
    [byId.get(secondRow).status, Number(byId.get(secondRow).quantity)],
    ['pending', 1]
  );
  ok(
    'the saved row still shows what was asked',
    [Number(byId.get(firstRow).quantity), Number(byId.get(firstRow).quantity_requested)],
    [2, 2]
  );
  ok('the two copies leave the free count once', await availability(connection), {
    total: 10,
    reserved: 0,
    delivered: 2,
    free: 8,
  });
  ok(
    'the waiting row is still holding its copy',
    Number(
      (await getSharedItemsForViewer(connection, [ASKER])).find(
        (row) => row.item_name === SECOND
      ).reserved
    ),
    1
  );

  const afterFirst = await getFulfillForm(connection, oneToken);
  ok(
    'the same link still answers the rest',
    afterFirst ? afterFirst.rows.map((row) => Number(row.id)) : null,
    [secondRow]
  );
  ok(
    'saving the answered row again changes nothing',
    (
      await recordFulfillment(connection, {
        token: oneToken,
        sentById: new Map([[firstRow, 2]]),
      })
    ).rows.length,
    0
  );
  ok(
    'and the waiting row is still waiting afterwards',
    (await getFulfillForm(connection, oneToken)).rows.map((row) => Number(row.id)),
    [secondRow]
  );

  const rest = await recordFulfillment(connection, {
    token: oneToken,
    sentById: new Map([[secondRow, 1]]),
  });
  ok('the last row answers with the same link', rest ? [rest.fulfilled, rest.copies] : null, [1, 1]);
  ok(
    'the link stops only once every row is answered',
    await getFulfillForm(connection, oneToken),
    null
  );
  ok('the owner has nothing left to answer', (await getOwnerRequests(connection, [OWNER])).length, 0);

  console.log('\n10. Repeated asks for one item read as one number, and are answered together');
  await uploadItems(connection, OWNER, [{ name: ITEM, count: 12 }]);
  const groupedItemId = Number(
    (await getSharedItemsForViewer(connection, [ASKER])).find((row) => row.item_name === ITEM).id
  );

  const firstAsk = await askFor(connection, askerId, groupedItemId, 2);
  await submitDrafts(connection, { userId: askerId });
  const secondAsk = await askFor(connection, askerId, groupedItemId, 2);
  await submitDrafts(connection, { userId: askerId });
  const thirdAsk = await askFor(connection, askerId, groupedItemId, 1);
  await submitDrafts(connection, { userId: askerId });

  const grouped = await getOwnerRequests(connection, [OWNER]);
  ok(
    'two, two and one asks are one row of five',
    grouped.map((row) => [Number(row.id), row.asked, row.requests]),
    [[firstAsk, 5, 3]]
  );
  ok('the row still knows every request behind it', grouped[0].ids, [firstAsk, secondAsk, thirdAsk]);

  const spread = await recordOwnerGroupAnswer(connection, {
    accountNames: [OWNER],
    anchorId: firstAsk,
    sent: 3,
  });
  ok(
    'three copies answer the oldest asks first',
    spread ? [spread.copies, spread.fulfilled, spread.cancelled] : null,
    [3, 2, 0]
  );

  const [spreadRows] = await connection.execute(
    'SELECT id, status, quantity, quantity_requested FROM itemshare_requests WHERE id IN (?, ?, ?) ORDER BY id ASC',
    [firstAsk, secondAsk, thirdAsk]
  );
  ok(
    'the oldest fills, the next takes the remainder, the rest still waits',
    spreadRows.map((row) => [Number(row.id), row.status, Number(row.quantity)]),
    [
      [firstAsk, 'fulfilled', 2],
      [secondAsk, 'fulfilled', 1],
      [thirdAsk, 'pending', 1],
    ]
  );
  ok(
    'the short handover keeps the ask it answered',
    [Number(spreadRows[1].quantity), Number(spreadRows[1].quantity_requested)],
    [1, 2]
  );

  const restGrouped = await getOwnerRequests(connection, [OWNER]);
  ok(
    'what is left lists as one row again',
    restGrouped.map((row) => [Number(row.id), row.asked]),
    [[thirdAsk, 1]]
  );

  const notFulfilled = await recordOwnerGroupAnswer(connection, {
    accountNames: [OWNER],
    anchorId: thirdAsk,
    sent: 0,
  });
  ok('Not fulfilled cancels the row', [notFulfilled.fulfilled, notFulfilled.cancelled], [0, 1]);
  ok('and the list is empty again', (await getOwnerRequests(connection, [OWNER])).length, 0);

  console.log(`\n${checks} checks passed. ${config.database} left in place for inspection.`);
  console.log('Drop it with: DROP DATABASE ' + config.database + ';');
} catch (error) {
  console.error(`\nFAILED after ${checks} checks: ${error.message}`);
  if (error.actual !== undefined) {
    console.error(`  expected: ${JSON.stringify(error.expected)}`);
    console.error(`  actual:   ${JSON.stringify(error.actual)}`);
  }
  process.exitCode = 1;
} finally {
  await connection.end();
}
