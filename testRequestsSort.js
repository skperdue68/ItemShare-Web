// The owner's requests table sorts by a queue of columns: the first heading pressed
// decides, the next one breaks its ties, and a press cycles ascending, descending, off.
//
// The queue is a cookie and the sorting itself is in the browser, so the two halves that
// could disagree - what `mail:asc,asked:desc` means, and how two rows compare under it -
// are both in /requests-sort.js, out of the DOM, and tested here without a page.

import assert from 'node:assert/strict';

import { renderOwnerRequestsCard } from './lib/views.js';
import {
  FIELDS,
  ORDER_COOKIE,
  cycleOrder,
  formatOrder,
  parseOrder,
  sortRows,
} from './public/requests-sort.js';

let total = 0;
let failures = 0;

async function t(name, run) {
  total += 1;

  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}`);
    console.log(`     ${error && error.message ? error.message : error}`);
  }
}

// ------------------------------------------------------------------ the queue

await t('a cookie reads back as a queue in the order it was written', () => {
  assert.deepEqual(parseOrder('mail:asc,asked:desc'), [
    { field: 'mail', dir: 'asc' },
    { field: 'asked', dir: 'desc' },
  ]);
});

await t('nothing to sort is an empty queue, not a default column', () => {
  assert.deepEqual(parseOrder(''), []);
  assert.deepEqual(parseOrder(undefined), []);
  assert.deepEqual(parseOrder('   '), []);
});

await t('rubbish in the cookie is dropped rather than guessed at', () => {
  assert.deepEqual(parseOrder('name:sideways'), [], 'a direction that does not exist');
  assert.deepEqual(parseOrder('colour:asc'), [], 'a column that does not exist');
  assert.deepEqual(parseOrder('name:asc,name:desc'), [{ field: 'name', dir: 'asc' }], 'twice');
  assert.deepEqual(parseOrder('name:asc,,asked:asc').length, 2, 'empty pieces are skipped');
});

await t('the queue goes back into the cookie the way it came out', () => {
  const written = formatOrder([
    { field: 'stored', dir: 'desc' },
    { field: 'name', dir: 'asc' },
  ]);

  assert.equal(written, 'stored:desc,name:asc');
  assert.deepEqual(parseOrder(written), [
    { field: 'stored', dir: 'desc' },
    { field: 'name', dir: 'asc' },
  ]);
  assert.equal(formatOrder([]), '');
});

await t('a first press sorts ascending', () => {
  assert.deepEqual(cycleOrder([], 'mail'), [{ field: 'mail', dir: 'asc' }]);
});

await t('a second press reverses in place, keeping its turn in the queue', () => {
  const order = cycleOrder([{ field: 'mail', dir: 'asc' }, { field: 'asked', dir: 'asc' }], 'mail');

  assert.deepEqual(order, [
    { field: 'mail', dir: 'desc' },
    { field: 'asked', dir: 'asc' },
  ]);
});

await t('a third press takes the column out and the ones after it move up', () => {
  const order = cycleOrder(
    [
      { field: 'mail', dir: 'desc' },
      { field: 'asked', dir: 'asc' },
      { field: 'name', dir: 'asc' },
    ],
    'mail'
  );

  assert.deepEqual(order, [
    { field: 'asked', dir: 'asc' },
    { field: 'name', dir: 'asc' },
  ]);
});

await t('a column asked for later joins the end, so it only breaks ties', () => {
  const order = cycleOrder([{ field: 'name', dir: 'asc' }], 'stored');

  assert.deepEqual(order, [
    { field: 'name', dir: 'asc' },
    { field: 'stored', dir: 'asc' },
  ]);
});

await t('a field that is not sortable leaves the queue alone', () => {
  const order = [{ field: 'name', dir: 'asc' }];

  assert.deepEqual(cycleOrder(order, 'requested'), order);
});

// ------------------------------------------------------------------ the ordering

const row = (name, mail, asked, stored = '') => ({ name, mail, asked, stored });

await t('one column orders the rows ascending and descending', () => {
  const rows = [row('Bow', 'zed', 3), row('Axe', 'amy', 1), row('Crown', 'mel', 2)];

  assert.deepEqual(
    sortRows(rows, [{ field: 'name', dir: 'asc' }]).map((entry) => entry.name),
    ['Axe', 'Bow', 'Crown']
  );
  assert.deepEqual(
    sortRows(rows, [{ field: 'name', dir: 'desc' }]).map((entry) => entry.name),
    ['Crown', 'Bow', 'Axe']
  );
});

await t('the second column only decides what the first left tied', () => {
  const rows = [
    row('Bow', 'zed', 30),
    row('Axe', 'zed', 10),
    row('Crown', 'amy', 20),
  ];

  assert.deepEqual(
    sortRows(rows, [
      { field: 'mail', dir: 'asc' },
      { field: 'asked', dir: 'desc' },
    ]).map((entry) => entry.name),
    ['Crown', 'Bow', 'Axe'],
    'amy first, then the newest of the two zeds'
  );
});

await t('the order of the queue is the order of the presses, not of the headings', () => {
  const rows = [row('Bow', 'zed', 30), row('Axe', 'zed', 10)];

  assert.deepEqual(
    sortRows(rows, [
      { field: 'asked', dir: 'asc' },
      { field: 'mail', dir: 'desc' },
    ]).map((entry) => entry.name),
    ['Axe', 'Bow'],
    'asked is the first column even though Mail to sits to its left'
  );
});

await t('a row with nothing in the column sinks either way', () => {
  const rows = [row('Bow', 'zed', 1, ''), row('Axe', 'amy', 2, 'Bank 3'), row('Crown', 'mel', 3, 'Bag 1')];

  for (const dir of ['asc', 'desc']) {
    assert.deepEqual(
      sortRows(rows, [{ field: 'stored', dir }]).map((entry) => entry.name).at(-1),
      'Bow',
      `unknown at the bottom when sorting ${dir}`
    );
  }
});

await t('rows the queue cannot separate keep the order they arrived in', () => {
  const rows = [row('Bow', 'zed', 1), row('Axe', 'zed', 1), row('Crown', 'zed', 1)];

  assert.deepEqual(
    sortRows(rows, [{ field: 'mail', dir: 'asc' }]).map((entry) => entry.name),
    ['Bow', 'Axe', 'Crown']
  );
});

await t('names compare as labels: case and digits do not decide the order', () => {
  const rows = [row('briarheart dagger', '', 1), row('Briarheart Dagger 10', '', 2), row('Apple', '', 3)];

  assert.deepEqual(
    sortRows(rows, [{ field: 'name', dir: 'asc' }]).map((entry) => entry.name),
    ['Apple', 'briarheart dagger', 'Briarheart Dagger 10'],
    'the plain dagger before its number ten'
  );
});

await t('an empty queue leaves the rows exactly as they came', () => {
  const rows = [row('Bow', 'zed', 3), row('Axe', 'amy', 1)];

  assert.deepEqual(sortRows(rows, []).map((entry) => entry.name), ['Bow', 'Axe']);
});

await t('the cookie name is its own, so the item list sort is untouched', () => {
  assert.equal(ORDER_COOKIE, 'itemshare_owner_sort');
  assert.notEqual(ORDER_COOKIE, 'itemshare_sort');
  assert.deepEqual(FIELDS, ['name', 'stored', 'mail', 'asked']);
});

// ------------------------------------------------------------------ the card's markup

const requestRows = [
  {
    id: 11,
    quality: 4,
    item_name: 'Briarheart Dagger',
    level: 50,
    champion_points: 160,
    trait: 'Precise',
    style_name: 'Breton',
    enchant_name: 'Glyph of Weapon Damage',
    owner_account_name: '@evainefaye4',
    location_label: 'Bank 3 (Eva)',
    requesters: ['@sender1'],
    first_submitted_at: new Date('2026-11-01T10:00:00Z'),
    last_submitted_at: new Date('2026-11-01T10:00:00Z'),
    requests: 1,
    asked: 1,
  },
  {
    id: 12,
    quality: 2,
    item_name: 'Alphabet Soup',
    level: 50,
    champion_points: 0,
    trait: '',
    style_name: '',
    enchant_name: '',
    owner_account_name: '@evainefaye4',
    location_label: '',
    requesters: ['@sender2', '@sender3'],
    first_submitted_at: new Date('2026-11-02T10:00:00Z'),
    last_submitted_at: new Date('2026-11-02T10:00:00Z'),
    requests: 2,
    asked: 2,
  },
];

const card = renderOwnerRequestsCard({ rows: requestRows });

await t('all four asked-for columns are sortable headings', () => {
  for (const field of ['name', 'stored', 'mail', 'asked']) {
    assert.match(card, new RegExp(`data-request-sort="${field}"`), `${field} does not sort`);
  }

  assert.match(card, /<span class="sort-queue" data-sort-queue hidden><\/span>/);

  const unsorted = [...card.matchAll(/aria-sort="none"/g)];
  assert.equal(unsorted.length, 4, 'each heading says it is not sorted yet');
});

await t('the two columns that describe an answer are still plain headings', () => {
  assert.match(card, /<th class="num">Requested<\/th>/);
  assert.match(card, /<th class="num">Amount Sent<\/th>/);
  assert.doesNotMatch(card, /<th>Item<\/th>/, 'the Item heading is a control now');
});

await t('every row carries what the sorts compare, unformatted', () => {
  assert.match(card, /data-sort-name="Briarheart Dagger"/);
  assert.match(card, /data-sort-stored="Bank 3 \(Eva\)"/);
  assert.match(card, /data-sort-mail="@sender1"/);
  assert.match(card, /data-sort-mail="@sender2, @sender3"/);

  const stamps = [...card.matchAll(/data-sort-asked="(\d+)"/g)].map((match) => Number(match[1]));

  assert.equal(stamps.length, 2);
  assert.equal(stamps[0], Date.parse('2026-11-01T10:00:00Z'), 'the ask time as a number');
  assert.ok(stamps[0] < stamps[1], 'and the later ask is larger');
});

await t('a row with no recorded place sorts as empty rather than as an em dash', () => {
  assert.match(card, /data-sort-stored=""/);
  assert.doesNotMatch(card, /data-sort-stored="&mdash;"/);
});

await t('the card says how the headings behave', () => {
  assert.match(card, /once for A to Z, twice for Z to A, three times to stop/);
  assert.match(card, /breaks the ties in what the first left/);
});

console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
