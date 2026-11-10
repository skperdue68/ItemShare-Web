// The basket note and "the hold follows the account", checked without a database.
//
// A tiny fake stands in for the two tables the queries touch: requests, and which
// person owns which ESO account. It cannot prove MariaDB runs the SQL as written -
// only a real one can - but it does prove what the code asks for and what it does
// with the answer.

import assert from 'node:assert/strict';

const store = await import(new URL('../lib/store.js', import.meta.url).href);

let passed = 0;

function ok(label, actual, expected) {
  assert.deepEqual(actual, expected, label);
  passed += 1;
  console.log(`  ok  ${label}`);
}

function draft(overrides) {
  return {
    quantity: 1,
    item_kind: 'inventory',
    status: 'draft',
    live: true,
    ...overrides,
  };
}

function makeWorld() {
  return {
    drafts: [
      // Asked for as a guest from an account that now belongs to person 8.
      draft({
        id: 11,
        requester_user_id: 7,
        requester_account_name: '@evainefaye2',
        shared_item_id: 83,
      }),
    ],
    accounts: [{ eso_account_name: '@evainefaye2', user_id: 8 }],
    calls: [],
    clockResets: [],
  };
}

function connectionFor(world) {
  const rows = [
    {
      id: 83,
      item_name: 'Style Page: Ayleid Lich Shoes',
      item_key_hash: 'hash-83',
      item_count: 2,
      held_quantity: 0,
      reserve_quantity: 0,
      account_name: '@evainefaye',
    },
  ];

  return {
    async execute(sql, params = []) {
      world.calls.push({ sql, params });

      // Giving the owner of an account the live holds that were made from it.
      if (/SET r\.requester_user_id = \?/.test(sql)) {
        const owner = Number(params[0]);
        const mover = Number(params[1]);
        const moving = world.drafts.filter(
          (entry) =>
            entry.status === 'draft' &&
            entry.live &&
            entry.requester_user_id !== mover &&
            world.accounts.some(
              (account) =>
                account.eso_account_name === entry.requester_account_name &&
                account.user_id === owner
            )
        );

        for (const entry of moving) {
          entry.requester_user_id = mover;
        }

        return [{ affectedRows: moving.length }, []];
      }

      if (/expires_at = \(NOW\(\)/.test(sql)) {
        world.clockResets.push(Number(params[0]));
        return [{ affectedRows: 1 }, []];
      }

      // The per-row note: this person's own live drafts on these rows.
      if (/requester_user_id = \?/.test(sql) && /shared_item_id IN/.test(sql)) {
        const uid = Number(params[0]);
        const ids = params.slice(1).map(Number);
        const sums = new Map();

        for (const entry of world.drafts) {
          if (entry.requester_user_id !== uid || entry.status !== 'draft' || !entry.live) {
            continue;
          }

          if (!ids.includes(entry.shared_item_id)) {
            continue;
          }

          sums.set(entry.shared_item_id, (sums.get(entry.shared_item_id) || 0) + entry.quantity);
        }

        return [[...sums].map(([target_id, held]) => ({ target_id, held })), []];
      }

      if (/FROM itemshare_shared_items i/i.test(sql)) {
        return [rows.map((row) => ({ ...row })), []];
      }

      return [[], []];
    },
  };
}

console.log('1. The note is read by person, not by the account name on the row');
{
  const world = makeWorld();
  const connection = connectionFor(world);

  const stranger = await store.getSharedItemsForViewer(connection, ['@evainefaye2'], {
    viewerUserId: 8,
  });
  ok('the account name alone does not make the hold "in your basket"', stranger[0].my_draft_quantity, 0);

  const holder = await store.getSharedItemsForViewer(connection, ['@evainefaye2'], {
    viewerUserId: 7,
  });
  ok('the person the draft is filed under sees it', holder[0].my_draft_quantity, 1);

  const visitor = await store.getSharedItemsForViewer(connection, []);
  ok('a visitor is told nothing about a basket', visitor[0].my_draft_quantity, 0);

  const noteCalls = world.calls.filter(
    (call) => /requester_user_id = \?/.test(call.sql) && /shared_item_id IN/.test(call.sql)
  );
  ok(
    'the query never matches on account names',
    noteCalls.length > 0 && !/requester_account_name IN/.test(noteCalls[0].sql),
    true
  );
  ok('it passes the person id first', noteCalls[0].params[0], 8);
}

console.log('\n2. The hold follows the account that was asked from');
{
  const world = makeWorld();
  const connection = connectionFor(world);

  ok('one draft changes hands', await store.claimHoldsForOwnedAccounts(connection, { userId: 8 }), 1);

  const after = await store.getSharedItemsForViewer(connection, ['@evainefaye2'], {
    viewerUserId: 8,
  });
  ok('the owner can now see it in their basket', after[0].my_draft_quantity, 1);
  ok('...and send or cancel it', world.drafts[0].requester_user_id, 8);
  ok('...with a full clock rather than the leftovers', world.clockResets, [8]);
  ok('no account link is changed by it', world.accounts, [
    { eso_account_name: '@evainefaye2', user_id: 8 },
  ]);
}

console.log('\n2b. A draft with no person id at all follows the account too');
{
  const world = makeWorld();
  world.drafts[0].requester_user_id = null;
  const connection = connectionFor(world);

  ok(
    'a row missing its person id is still claimed by the account owner',
    await store.claimHoldsForOwnedAccounts(connection, { userId: 8 }),
    1
  );
  ok('and it ends up theirs', world.drafts[0].requester_user_id, 8);

  const sql = world.calls
    .find((call) => /SET r\.requester_user_id/.test(call.sql))
    .sql.replace(/\s+/g, ' ');
  ok('the comparison allows for a null id', sql.includes('r.requester_user_id IS NULL'), true);
}

console.log('\n3. Somebody else\'s account is left alone');
{
  const world = makeWorld();
  world.accounts.push({ eso_account_name: '@someoneelse', user_id: 9 });
  world.drafts.push(
    draft({
      id: 12,
      requester_user_id: 9,
      requester_account_name: '@someoneelse',
      shared_item_id: 83,
    })
  );
  const connection = connectionFor(world);

  ok('only the draft from the owned account moves', await store.claimHoldsForOwnedAccounts(connection, { userId: 8 }), 1);
  ok(
    'the other person still holds their own',
    world.drafts.find((entry) => entry.id === 12).requester_user_id,
    9
  );
}

console.log('\n4. Nothing is touched when there is nothing to claim');
{
  const world = makeWorld();
  world.drafts[0].requester_user_id = 8; // already theirs
  const connection = connectionFor(world);

  ok('a draft of their own is not adopted', await store.claimHoldsForOwnedAccounts(connection, { userId: 8 }), 0);
  ok('and no clock is reset', world.clockResets, []);

  const lapsed = makeWorld();
  lapsed.drafts[0].live = false;
  ok(
    'a hold that already lapsed is left for the sweeper',
    await store.claimHoldsForOwnedAccounts(connectionFor(lapsed), { userId: 8 }),
    0
  );
  ok('nobody signed in asks no question', await store.claimHoldsForOwnedAccounts(connection, { userId: 0 }), 0);
}

console.log('\n5. The claim query keeps the guards that make it safe');
{
  const world = makeWorld();
  const connection = connectionFor(world);
  await store.claimHoldsForOwnedAccounts(connection, { userId: 8 });

  const sql = world.calls
    .find((call) => /SET r\.requester_user_id/.test(call.sql))
    .sql.replace(/\s+/g, ' ');

  for (const guard of [
    'a.user_id = ?',
    "r.status = 'draft'",
    'r.expires_at > NOW()',
    'r.requester_user_id IS NULL',
    'r.requester_user_id <> ?',
  ]) {
    ok(`guarded by ${guard}`, sql.includes(guard), true);
  }

  ok('ownership decides it, not the identity used to ask', /provider/.test(sql), false);
}

console.log(`\n${passed} BASKET CHECKS PASSED`);
