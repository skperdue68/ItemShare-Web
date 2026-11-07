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
import { extractShareData } from './lib/savedVars.js';
import {
  createRequest,
  getAlwaysShareForViewer,
  getFulfillForm,
  getOwnerRequests,
  getRequesterNotifications,
  getRequesterRequests,
  getSharedItemsForViewer,
  getViewerFacets,
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

  // Somebody signed in who has not uploaded yet: no guilds to compare, so the list is
  // everything shared. They cannot ask for it - the request route refuses - but the read
  // has to work, because an empty list is no reason to upload.
  console.log('\n1b. A viewer with no account of their own still sees what is shared');
  const guestItems = await getSharedItemsForViewer(connection, []);
  ok(
    'the shared row is listed without any account',
    guestItems.map((row) => row.item_name),
    [ITEM]
  );
  const guestFacets = await getViewerFacets(connection, []);
  ok(
    'the filter options come from the same list',
    guestFacets.owners,
    [...new Set(guestItems.map((row) => row.account_name))]
  );
  ok(
    'and nothing is offered yet',
    (await getAlwaysShareForViewer(connection, [])).length,
    0
  );
  // An account attached by hand has no guild rows - the addon has never said which
  // guilds it is in - so the guild rule cannot apply and the list is unrestricted.
  ok(
    'an account with no guilds of its own still sees the shared row',
    (await getSharedItemsForViewer(connection, ['@NoGuildsYet'])).map((row) => row.item_name),
    [ITEM]
  );

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

  // What the answer email is built from: one address per person, and the outcome of
  // each row as it was recorded, not as it was asked for.
  const notices = await getRequesterNotifications(connection, [requestId]);
  ok(
    'the person who asked can be told what became of it',
    notices.map((row) => [row.email, row.status, row.sent, row.asked]),
    [['asker@test.invalid', 'fulfilled', 2, 3]]
  );
  ok(
    'and the message can name where the item came from',
    notices.map((row) => [row.ownerAccount, row.itemName]),
    [[OWNER, ITEM]]
  );
  ok('no answered rows means nobody to tell', (await getRequesterNotifications(connection, [])).length, 0);

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

  const cancelledNotices = await getRequesterNotifications(connection, [cancelledId]);
  ok(
    'a cancellation is addressed to the asker as well',
    cancelledNotices.map((row) => [row.status, row.sent, row.asked]),
    [['cancelled', 4, 4]]
  );
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
  ok(
    'and every answered row names the item, the copies and the asker, so the confirmation can',
    spread.rows.map((row) => [row.itemName, row.requesterAccount, row.sent]),
    [
      [ITEM, ASKER, 2],
      [ITEM, ASKER, 1],
    ]
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
  ok(
    'and the cancelled row names the item and the asker too',
    [notFulfilled.rows[0].itemName.length > 0, notFulfilled.rows[0].requesterAccount],
    [true, ASKER]
  );
  ok('and the list is empty again', (await getOwnerRequests(connection, [OWNER])).length, 0);

  console.log('\n11. An upload leaves an item alone while a request on it is open');
  await uploadItems(connection, OWNER, [
    { name: ITEM, count: 4 },
    { name: SECOND, count: 9 },
  ]);

  const holdItem = (await getSharedItemsForViewer(connection, [ASKER])).find(
    (row) => row.item_name === ITEM
  );
  await askFor(connection, askerId, Number(holdItem.id), 1);
  await submitDrafts(connection, { userId: askerId });

  const beforeHold = await availability(connection);
  const refreshed = await uploadItems(connection, OWNER, [
    { name: ITEM, count: 40 },
    { name: SECOND, count: 6 },
  ]);
  const afterHold = await availability(connection);

  ok('the asked-for item keeps the count it had', afterHold.total, beforeHold.total);
  ok('its open request is still holding a copy', afterHold.reserved, 1);
  ok(
    'the upload names the item it left alone',
    refreshed.heldBack.map((row) => [row.itemName, row.requests]),
    [[ITEM, 1]]
  );
  ok(
    'the rest of the file was refreshed',
    Number(
      (await getSharedItemsForViewer(connection, [ASKER])).find(
        (row) => row.item_name === SECOND
      ).item_count
    ),
    6
  );

  const heldHistory = await getRequesterRequests(connection, askerId);
  ok(
    'the request it protected is still waiting',
    heldHistory.some((row) => row.status === 'pending' && row.item_name === ITEM),
    true
  );

  console.log('\n12. A file copied to a new account still names the old one inside its items');
  // Exactly the shape of a saved variables file copied between accounts: the tables are
  // renamed, but every entry keeps the accountName the addon wrote when it was dumped.
  const copiedFile = `ItemShareSavedVars =
{
    ["Default"] =
    {
        ["@TestCopied"] =
        {
            ["$AccountWide"] =
            {
                ["version"] = 3,
                ["addonVersion"] = "1.10.0",
                ["guilds"] =
                {
                    ["${GUILD}"] = "Test Guild",
                },
                ["characterGuilds"] =
                {
                    ["Tester"] =
                    {
                        ["guildIds"] = { ${GUILD} },
                        ["updatedAt"] = 1793866476,
                    },
                },
                ["sharedItems"] =
                {
                    ["copied-key"] =
                    {
                        ["accountName"] = "@TestOriginal",
                        ["characterName"] = "Tester",
                        ["itemName"] = "Copied Item",
                        ["count"] = 3,
                    },
                    ["moved-key"] =
                    {
                        ["accountName"] = "@TestSecond",
                        ["characterName"] = "Tester",
                        ["itemName"] = "Moved Item",
                        ["count"] = 1,
                    },
                },
                ["alwaysShare"] =
                {
                    ["offer-key"] =
                    {
                        ["accountName"] = "@TestOriginal",
                        ["characterName"] = "Tester",
                        ["itemName"] = "Copied Offer",
                    },
                },
            },
        },
        ["@TestSecond"] =
        {
            ["$AccountWide"] =
            {
                ["version"] = 3,
                ["addonVersion"] = "1.10.0",
                ["sharedItems"] =
                {
                },
            },
        },
    },
}`;

  const copied = extractShareData(copiedFile);
  ok('both accounts in the file are read', copied.accounts, ['@TestCopied', '@TestSecond']);
  ok(
    'an item follows the table it sits in, not the stale name inside it',
    copied.items.map((item) => [item.itemKey, item.accountName]).sort(),
    [
      ['copied-key', '@TestCopied'],
      // A name that really is another account of this file is still honoured.
      ['moved-key', '@TestSecond'],
    ]
  );
  ok(
    'a standing offer follows its table the same way',
    copied.alwaysShare.map((entry) => entry.accountName),
    ['@TestCopied']
  );
  ok(
    'the item keeps the guild it was offered to',
    copied.items.find((item) => item.itemKey === 'copied-key').guildIds,
    [GUILD]
  );
  ok(
    'the bookkeeping field does not survive into a stored row',
    [...copied.items, ...copied.alwaysShare].filter((row) => 'pathAccount' in row).length,
    0
  );
  ok(
    'every item of the copied file lands under an account the upload will store',
    copied.items.filter((item) => copied.accounts.includes(item.accountName)).length,
    2
  );

  console.log('\n13. A version 3 file stores its items under all five guilds');

  // Five guilds, five items, one registry and one character snapshot. The whole link is
  // character -> guildIds -> registry, because the items carry no guild fields at all.
  const FIVE_GUILDS = [
    [9001, 'Test Guild'],
    [9002, 'Second Guild'],
    [9003, 'Third Guild'],
    [9004, 'Fourth Guild'],
    [9005, 'Fifth Guild'],
  ];
  const GUILD_IDS = FIVE_GUILDS.map(([guildId]) => guildId);
  const guildPairs = (indent) =>
    FIVE_GUILDS.map(([guildId, name]) => `${indent}["${guildId}"] = "${name}",`).join('\n');
  const guildedItems = (account) =>
    Array.from(
      { length: 5 },
      (_, index) => `          ["guilded-key-${index + 1}"] =
          {
            ["accountName"] = "${account}",
            ["characterName"] = "Tester",
            ["itemName"] = "Guilded Item ${index + 1}",
            ["count"] = ${index + 4},
            ["locationKey"] = "inventory:tester",
          },`
    ).join('\n');

  const v3File = `ItemShareSavedVars =
{
  ["Default"] =
  {
    ["@TestV3"] =
    {
      ["$AccountWide"] =
      {
        ["version"] = 3,
        ["addonVersion"] = "1.10.0",
        ["guilds"] =
        {
${guildPairs('          ')}
        },
        ["characterGuilds"] =
        {
          ["Tester"] =
          {
            ["guildIds"] = { ${GUILD_IDS.join(', ')} },
            ["updatedAt"] = 1793866476,
          },
        },
        ["guildsUpdatedAt"] = 1793866476,
        ["sharedItems"] =
        {
${guildedItems('@TestV3')}
        },
      },
    },
  },
}`;

  const parsedV3 = extractShareData(v3File);

  ok(
    'the registry gives every guild its name',
    [...parsedV3.guilds.entries()].sort((a, b) => a[0] - b[0]),
    FIVE_GUILDS
  );
  ok('the file finds five items', parsedV3.items.length, 5);
  ok(
    'each item follows its character to all five guilds',
    parsedV3.items.map((item) => item.guildIds.slice().sort((a, b) => a - b)),
    parsedV3.items.map(() => GUILD_IDS)
  );

  const storeFile = (account, parsed, sourceFile) =>
    replaceAccounts(
      connection,
      [
        {
          accountName: account,
          items: parsed.items,
          alwaysShare: parsed.alwaysShare,
          guilds: parsed.accountGuilds.get(account),
        },
      ],
      { sourceFile }
    );

  const v3Upload = (await storeFile('@TestV3', parsedV3, 'ItemShareSavedVars.lua'))[0];

  ok('the upload records five guilds', v3Upload.guildCount, 5);

  const storedRows = async (accountName) => {
    const [rows] = await connection.execute(
      `SELECT i.item_key, i.item_name, i.item_count,
              GROUP_CONCAT(g.guild_id ORDER BY g.guild_id) AS guild_ids
         FROM itemshare_shared_items i
         LEFT JOIN itemshare_shared_item_guilds link ON link.item_id = i.id
         LEFT JOIN itemshare_guilds g ON g.guild_id = link.guild_id
        WHERE i.account_name = ?
        GROUP BY i.id
        ORDER BY i.item_key`,
      [accountName]
    );

    return rows.map((row) => [
      row.item_key,
      row.item_name,
      Number(row.item_count),
      String(row.guild_ids || ''),
    ]);
  };

  const v3Rows = await storedRows('@TestV3');

  ok(
    'five rows, keyed and counted as the file says',
    v3Rows.map((row) => [row[0], row[2]]),
    ['1', '2', '3', '4', '5'].map((step) => [`guilded-key-${step}`, Number(step) + 3])
  );
  ok(
    'every item is offered to all five guilds',
    v3Rows.map((row) => row[3]),
    Array.from({ length: 5 }, () => GUILD_IDS.join(','))
  );
  ok(
    'the guild names the UI reads come from the registry',
    (
      await connection.execute(
        'SELECT guild_id, guild_name FROM itemshare_guilds WHERE guild_id IN (9001, 9002, 9003, 9004, 9005) ORDER BY guild_id'
      )
    )[0].map((row) => [Number(row.guild_id), row.guild_name]),
    FIVE_GUILDS
  );
  ok(
    'the account is in exactly five guilds',
    Number(
      (
        await connection.execute(
          'SELECT COUNT(*) AS guildCount FROM itemshare_account_guilds WHERE account_name = ?',
          ['@TestV3']
        )
      )[0][0].guildCount
    ),
    5
  );

  console.log('\n14. A registered guild with no items, and a character with no snapshot');

  const idleFile = `ItemShareSavedVars =
{
  ["Default"] =
  {
    ["@TestIdle"] =
    {
      ["$AccountWide"] =
      {
        ["version"] = 3,
        ["addonVersion"] = "1.10.0",
        ["guilds"] =
        {
          ["9101"] = "Seen Guild",
          ["9102"] = "Idle Guild",
        },
        ["characterGuilds"] =
        {
          ["Tester"] =
          {
            ["guildIds"] = { 9101 },
            ["updatedAt"] = 1793866476,
          },
        },
        ["guildsUpdatedAt"] = 1793866476,
        ["sharedItems"] =
        {
          ["seen-key"] =
          {
            ["itemName"] = "Seen Item",
            ["characterName"] = "Tester",
            ["count"] = 2,
          },
          ["unsnapshotted-key"] =
          {
            ["itemName"] = "Unsnapshotted Item",
            ["characterName"] = "Nobody",
            ["count"] = 1,
          },
        },
      },
    },
  },
}`;

  const idle = extractShareData(idleFile);
  ok('a guild registered but on no character is still read', idle.guilds.get(9102), 'Idle Guild');
  ok(
    "an item follows its character to that character's guild",
    idle.items.find((item) => item.itemKey === 'seen-key').guildIds,
    [9101]
  );
  ok(
    'a character with no snapshot falls back to the account, not to nothing',
    idle.items
      .find((item) => item.itemKey === 'unsnapshotted-key')
      .guildIds.slice()
      .sort((a, b) => a - b),
    [9101, 9102]
  );

  await storeFile('@TestIdle', idle, 'ItemShareSavedVars.lua');

  ok(
    'the guild no item names is still upserted with its name',
    (await connection.execute('SELECT guild_name FROM itemshare_guilds WHERE guild_id = 9102'))[0].map(
      (row) => row.guild_name
    ),
    ['Idle Guild']
  );

  console.log('\n15. The item builder survives the fields the addon will drop');

  // The table key is empty and there is no itemKey: the link and the location are all
  // that is left to identify the row. `count` is gone too, so heldCount - reserve is the
  // shareable number.
  const minimalFile = `ItemShareSavedVars =
{
  ["Default"] =
  {
    ["@TestMinimal"] =
    {
      ["$AccountWide"] =
      {
        ["version"] = 3,
        ["addonVersion"] = "1.11.0",
        ["guilds"] = { ["9201"] = "Minimal Guild" },
        ["sharedItems"] =
        {
          [""] =
          {
            ["itemLink"] = "|H0:item:30357:175|h|h",
            ["locationKey"] = "inventory:tester",
            ["itemName"] = "Lockpick",
            ["characterName"] = "Tester",
            ["heldCount"] = 200,
            ["reserve"] = 25,
          },
        },
      },
    },
  },
}`;

  const minimal = extractShareData(minimalFile);
  const lockpick = minimal.items[0];

  ok(
    'the key is the link plus the place it was found',
    lockpick.itemKey,
    '|H0:item:30357:175|h|h||inventory:tester'
  );
  ok('the count is what is held minus what is kept back', lockpick.itemCount, 175);
  ok('the account comes from the table it sits under', lockpick.accountName, '@TestMinimal');

  console.log('\n16. A schema 4 file keeps its reserve in its own table');

  // The shape the addon writes now: no `count` and no `reserve` on the entry, the amount
  // kept back in `locationReserves` keyed by link and location, and an always-shared item
  // that is not repeated in `sharedItems`.
  const v4File = `ItemShareSavedVars =
{
  ["Default"] =
  {
    ["@TestV4"] =
    {
      ["$AccountWide"] =
      {
        ["version"] = 4,
        ["schema"] = 4,
        ["addonVersion"] = "1.10.1",
        ["guilds"] = { ["9301"] = "Reserve Guild" },
        ["locationReserves"] =
        {
          ["|H0:item:57151:154|h|h||bank"] = 5,
          ["|H0:item:424242:1|h|h||bank"] = 3,
        },
        ["characterGuilds"] =
        {
          ["Tester"] =
          {
            ["guildIds"] = { 9301 },
            ["updatedAt"] = 1793916710,
          },
        },
        ["sharedItems"] =
        {
          ["|H0:item:57151:154|h|h||bank"] =
          {
            ["itemName"] = "Sanded Maple",
            ["itemLink"] = "|H0:item:57151:154|h|h",
            ["locationKey"] = "bank",
            ["characterName"] = "Tester",
            ["heldCount"] = 200,
          },
        },
        ["alwaysShare"] =
        {
          ["|H0:item:87695:4:1|h|h"] =
          {
            ["itemName"] = "Ghastly Eye Bowl",
            ["itemLink"] = "|H0:item:87695:4:1|h|h",
            ["characterName"] = "Tester",
            ["lastUpdatedAt"] = 1793916741,
          },
        },
      },
    },
  },
}`;

  const v4 = extractShareData(v4File);
  const [reservedStack] = v4.items;

  ok('the reserve is matched by item link and location', reservedStack.reserveQuantity, 5);
  // The second reserve belongs to an item that is not being shared at all. Holding some
  // back is not the same as offering the rest, so it must not become a row.
  ok('a reserve on its own shares nothing', v4.items.length, 1);
  ok('the stack offers what is held minus the reserve', reservedStack.itemCount, 195);
  ok('the bag still says how much was there', reservedStack.heldQuantity, 200);
  ok(
    'an always-shared item arrives with no count of its own',
    v4.alwaysShare.map((entry) => [entry.itemName, entry.itemCount, entry.reserveQuantity]),
    [['Ghastly Eye Bowl', undefined, 0]]
  );

  await storeFile('@TestV4', v4, 'ItemShareSavedVars.lua');

  ok(
    'the upload stores the reserve, not the bag count',
    (await storedRows('@TestV4')).map((row) => [row[1], row[2]]),
    [['Sanded Maple', 195]]
  );
  ok(
    'the reserve is kept for the note under the item name',
    (
      await connection.execute(
        'SELECT reserve_quantity FROM itemshare_shared_items WHERE account_name = ?',
        ['@TestV4']
      )
    )[0].map((row) => Number(row.reserve_quantity)),
    [5]
  );
  ok(
    'the reserve for an unshared item adds no row',
    Number(
      (
        await connection.execute(
          'SELECT COUNT(*) AS rowCount FROM itemshare_shared_items WHERE account_name = ?',
          ['@TestV4']
        )
      )[0][0].rowCount
    ),
    1
  );
  ok(
    'the owner sees the offer although the item is not shared as stock',
    (await getAlwaysShareForViewer(connection, ['@TestV4'])).map((row) => row.item_name),
    ['Ghastly Eye Bowl']
  );

  console.log('\n17. Addon 1.10.7 keeps its reserve per location');

  // The same Soul Gem link in three places, with 113 of the 400 in house storage 8 kept
  // back. The reserve belongs to that stack, so the bank and bag stacks stay whole.
  const soulGemLink = '|H0:item:33271:31:50:0:0:0:0:0:0:0:0:0:0:0:0:36:0:0:0:0:0|h|h';
  const soulGemFile = (linkReserves, locationReserves = `{ ["${soulGemLink}||housestorage:8"] = 113 }`) => `ItemShareSavedVars =
{
    ["Default"] =
    {
        ["@TestLoc"] =
        {
            ["$AccountWide"] =
            {
                ["schema"] = 4,
                ["version"] = 4,
                ["addonVersion"] = "1.10.7",
                ["guilds"] = { ["813755"] = "Ghost Bane" },
                ["characterGuilds"] =
                {
                    ["Aurielle Fairdew"] =
                    {
                        ["guildIds"] = { 813755 },
                        ["updatedAt"] = 1793924974,
                    },
                },
                ["reserves"] = ${linkReserves},
                ["locationReserves"] = ${locationReserves},
                ["alwaysShare"] = { },
                ["sharedItems"] =
                {
                    ["${soulGemLink}||bank"] =
                    {
                        ["itemName"] = "Soul Gem",
                        ["itemLink"] = "${soulGemLink}",
                        ["locationKey"] = "bank",
                        ["sharedFrom"] = "Bank",
                        ["characterName"] = "Aurielle Fairdew",
                        ["heldCount"] = 1614,
                    },
                    ["${soulGemLink}||housestorage:8"] =
                    {
                        ["itemName"] = "Soul Gem",
                        ["itemLink"] = "${soulGemLink}",
                        ["locationKey"] = "housestorage:8",
                        ["sharedFrom"] = "House Storage 8",
                        ["characterName"] = "Aurielle Fairdew",
                        ["heldCount"] = 400,
                    },
                    ["${soulGemLink}||inventory:aurielle fairdew"] =
                    {
                        ["itemName"] = "Soul Gem",
                        ["itemLink"] = "${soulGemLink}",
                        ["locationKey"] = "inventory:aurielle fairdew",
                        ["sharedFrom"] = "Inventory (Aurielle Fairdew)",
                        ["characterName"] = "Aurielle Fairdew",
                        ["heldCount"] = 800,
                    },
                },
            },
        },
    },
}`;

  const byLocation = (data) =>
    data.items.map((entry) => [entry.locationKey, entry.reserveQuantity, entry.itemCount]);

  ok('the location reserve is read from its own table', byLocation(extractShareData(soulGemFile('{ }'))), [
    ['bank', 0, 1614],
    ['housestorage:8', 113, 287],
    ['inventory:aurielle fairdew', 0, 800],
  ]);
  // The older link-only table is not a fallback: a file that carries only that keeps
  // nothing back, rather than having its reserve guessed at for every stack.
  ok(
    'an older link-only reserve is ignored',
    byLocation(extractShareData(soulGemFile(`{ ["${soulGemLink}"] = 7 }`, '{ }'))),
    [
      ['bank', 0, 1614],
      ['housestorage:8', 0, 400],
      ['inventory:aurielle fairdew', 0, 800],
    ]
  );

  await storeFile('@TestLoc', extractShareData(soulGemFile('{ }')), 'ItemShareSavedVars.lua');
  const [soulRows] = await connection.execute(
    'SELECT location_key, item_count, reserve_quantity FROM itemshare_shared_items WHERE account_name = ? ORDER BY location_key',
    ['@TestLoc']
  );
  ok(
    'one location is short by its reserve and the others are whole',
    soulRows.map((row) => [row.location_key, Number(row.item_count), Number(row.reserve_quantity)]),
    [
      ['bank', 1614, 0],
      ['housestorage:8', 287, 113],
      ['inventory:aurielle fairdew', 800, 0],
    ]
  );

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
