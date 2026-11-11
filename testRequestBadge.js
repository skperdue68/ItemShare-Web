#!/usr/bin/env node
// The number on the avatar: how many asks are waiting on this person's own items.
//
// The badge is drawn from a count the server puts on the user before the page is rendered,
// so the markup is what is checked here - that it appears only when something is waiting,
// that it says "request" or "requests" the way a reader hears it, and that a big number
// does not make the circle wider than the avatar it sits on. The count itself is one
// query, so its shape is read the way the other store tests read theirs, and having no
// linked account has to answer without touching the database at all.
//
//   npm run test:request-badge

import assert from 'node:assert/strict';

import { countOwnerRequests } from './lib/store.js';
import { renderOwnerRequestsPage } from './lib/views.js';

let total = 0;
let failures = 0;

async function t(name, fn) {
  total += 1;

  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}

const user = {
  username: 'Develia',
  provider: 'discord',
  providerLabel: 'Discord',
};

/** A page an owner sees, with the count the server would have hung on the user. */
const pageFor = (waiting) =>
  renderOwnerRequestsPage({
    accounts: [],
    rows: [],
    user: waiting === undefined ? { ...user } : { ...user, pendingRequests: waiting },
  });

// ------------------------------------------------------------------- the markup

await t('a request waiting puts a number on the avatar', () => {
  const html = pageFor(3);

  assert.match(html, /<span class="avatar-slot">/);
  assert.match(html, /<span class="avatar-badge" aria-hidden="true">3<\/span>/);
  assert.ok(
    html.indexOf('avatar-slot') < html.indexOf('avatar-badge'),
    'the badge is in the same box as the avatar'
  );

  const button = html.slice(html.indexOf('id="accountMenuButton"'), html.indexOf('</button>'));

  assert.match(button, /avatar-badge/, 'and inside the button that opens the menu');
});

await t('nothing waiting draws no circle at all', () => {
  assert.doesNotMatch(pageFor(0), /avatar-badge/);
  assert.doesNotMatch(pageFor(0), /requests to process/);
});

await t('a page drawn before the count is known draws no circle', () => {
  assert.doesNotMatch(pageFor(undefined), /avatar-badge/);
});

await t('a count that is not a number draws no circle', () => {
  assert.doesNotMatch(pageFor('nonsense'), /avatar-badge/);
});

await t('the button says the count to somebody who cannot see the circle', () => {
  assert.match(pageFor(3), /Account menu for Develia, 3 requests to process/);
  assert.match(pageFor(1), /Account menu for Develia, 1 request to process/);
});

await t('hovering the avatar says it too', () => {
  assert.match(pageFor(2), /title="Develia - 2 requests to process"/);
  assert.match(pageFor(0), /title="Develia"/);
});

await t('past ninety-nine the circle says 99+ rather than growing', () => {
  const html = pageFor(140);

  assert.match(html, />99\+<\/span>/);
  assert.doesNotMatch(html, />140</);
});

// -------------------------------------------------------------------- the count

function fakeConnection(rows) {
  const calls = [];

  return {
    calls,
    async execute(sql, params) {
      calls.push({ sql, params });
      return [rows];
    },
  };
}

await t('the count is one query for the person\'s own accounts', async () => {
  const connection = fakeConnection([{ waiting: 4 }]);
  const waiting = await countOwnerRequests(connection, ['@Eva', ' @Eva ', '@Alt']);

  assert.equal(waiting, 4);
  assert.equal(connection.calls.length, 1);

  const { sql, params } = connection.calls[0];

  assert.match(sql, /SELECT COUNT\(\*\) AS waiting/);
  assert.match(sql, /status = 'pending'/);
  assert.match(sql, /owner_account_name IN \(\?, \?\)/);
  assert.deepEqual(params, ['@Eva', '@Alt'], 'a name given twice is still one account');
});

await t('the grouping is the one the requests list uses, so the two numbers agree', async () => {
  const connection = fakeConnection([{ waiting: 0 }]);
  await countOwnerRequests(connection, ['@Eva']);

  const { sql } = connection.calls[0];

  assert.match(sql, /SELECT DISTINCT/);

  for (const column of [
    'r.item_kind',
    'COALESCE(r.trait',
    'COALESCE(r.enchant_name',
    'COALESCE(r.style_name',
    'COALESCE(r.required_level',
    'COALESCE(r.required_cp',
  ]) {
    assert.ok(sql.includes(column), `${column} is part of what makes two asks the same`);
  }

  assert.match(
    sql,
    /CASE WHEN COALESCE\(r\.item_id, 0\) > 0 THEN 0 ELSE r\.id END/,
    'an ask with no item id is its own group rather than merged with another'
  );
});

await t('no linked account means nothing to count, and nothing to ask', async () => {
  const connection = {
    async execute() {
      throw new Error('nothing should be asked of the database');
    },
  };

  assert.equal(await countOwnerRequests(connection, []), 0);
  assert.equal(await countOwnerRequests(connection, ['  ']), 0);
});

await t('the count is a number whatever the driver hands back', async () => {
  assert.equal(await countOwnerRequests(fakeConnection([{ waiting: '7' }]), ['@Eva']), 7);
  assert.equal(await countOwnerRequests(fakeConnection([]), ['@Eva']), 0);
});

console.log(`\n${total - failures}/${total} checks passed`);
process.exitCode = failures === 0 ? 0 : 1;
