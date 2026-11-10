#!/usr/bin/env node
// The item list's sort queue and the search box above it: what a cookie may hold, what a
// queue turns into as SQL, and what the table and the heading row draw for it. Renders the
// real table out of lib/views.js - no browser, no database.
//
//   npm run test:item-sort

import assert from 'node:assert/strict';

import { SORT_FIELDS, parseSortOrder, queuePlace } from './lib/sortQueue.js';
import { orderFor } from './lib/store.js';
import { inventoryTable, listSearchBox, offerTable } from './lib/views.js';

let total = 0;
let failures = 0;

function t(label, run) {
  total += 1;

  try {
    run();
    console.log('ok   ' + label);
  } catch (error) {
    failures += 1;
    console.log('FAIL ' + label + '\n     ' + error.message);
  }
}

function item(id, name, type, extra = {}) {
  return {
    id,
    item_name: name,
    item_type_name: type,
    item_count: 1,
    held_quantity: 0,
    reserve_quantity: 0,
    quality: 4,
    trait: '',
    location_label: '',
    account_name: '@Owner',
    first_seen_at_iso: '2026-11-01T10:00:00Z',
    ...extra,
  };
}

const rows = [
  item(1, 'Briarheart Dagger', 'Weapons', {
    trait: 'Sharpened',
    location_label: 'Bank 3',
    account_name: '@eva',
  }),
  item(2, 'Ancient Silk', 'Apparel', {
    trait: 'Impenetrable',
    location_label: 'Inventory (Eva)',
    account_name: '@sender2',
  }),
];

const queue = (...pairs) => pairs.map(([field, dir]) => ({ field, dir }));

// ------------------------------------------------------------------ the cookie
// The queue is the order the headings were pressed, so it is stored as written rather than
// as flags per column: what comes first has to be recoverable from the string itself.

t('a queue is read back in the order it was written', () => {
  assert.deepEqual(parseSortOrder('trait:desc,name:asc'), [
    { field: 'trait', dir: 'desc' },
    { field: 'name', dir: 'asc' },
  ]);
});

t('an empty or missing cookie means no queue at all', () => {
  assert.deepEqual(parseSortOrder(''), []);
  assert.deepEqual(parseSortOrder(undefined), []);
  assert.deepEqual(parseSortOrder(' , ,'), []);
});

t('every heading’s column is one the cookie may hold', () => {
  for (const field of SORT_FIELDS) {
    assert.deepEqual(parseSortOrder(`${field}:asc`), [{ field, dir: 'asc' }], field);
  }
  assert.deepEqual(SORT_FIELDS, ['name', 'added', 'type', 'trait', 'location', 'owner']);
});

t('a column that is not a heading is dropped rather than guessed at', () => {
  assert.deepEqual(parseSortOrder('mail:asc,stored:desc'), []);
});

t('a direction that is not one of the two is dropped', () => {
  assert.deepEqual(parseSortOrder('name:sideways,name:asc'), [{ field: 'name', dir: 'asc' }]);
});

t('a column cannot stand in the queue twice', () => {
  assert.deepEqual(parseSortOrder('name:asc,type:desc,name:desc'), [
    { field: 'name', dir: 'asc' },
    { field: 'type', dir: 'desc' },
  ], 'the first turn is kept');
});

// ------------------------------------------------------------------- the ranks

t('a heading in the queue knows its place and direction', () => {
  const order = queue(['name', 'asc'], ['trait', 'desc']);

  assert.deepEqual(queuePlace(order, 'name'), { rank: 1, dir: 'asc' });
  assert.deepEqual(queuePlace(order, 'trait'), { rank: 2, dir: 'desc' });
  assert.equal(queuePlace(order, 'type'), null, 'a column that is off has no place');
});

t('switching off the first sort renumbers the ones behind it', () => {
  const before = queue(['name', 'asc'], ['trait', 'desc'], ['owner', 'asc']);
  const after = before.slice(1);

  assert.equal(queuePlace(after, 'trait').rank, 1, 'the second sort is no longer second');
  assert.equal(queuePlace(after, 'owner').rank, 2);
});

t('reversing a sort keeps its place in the queue', () => {
  const order = queue(['name', 'desc'], ['type', 'asc']);

  assert.deepEqual(queuePlace(order, 'name'), { rank: 1, dir: 'desc' });
});

// -------------------------------------------------------- what the queue becomes
// The rows arrive already ordered, so the queue has to reach the query intact.

t('one column sorts by that column alone', () => {
  const sql = orderFor('i', queue(['name', 'asc']));

  assert.match(sql, /i\.item_name ASC/);
  assert.match(sql, /i\.item_name IS NULL OR i\.item_name = ''/, 'empty sinks');
});

t('the direction reaches the query', () => {
  assert.match(orderFor('i', queue(['trait', 'desc'])), /i\.trait DESC/);
  assert.doesNotMatch(orderFor('i', queue(['trait', 'asc'])), /i\.trait DESC/);
});

t('a second column is consulted after the first', () => {
  const sql = orderFor('i', queue(['owner', 'asc'], ['name', 'desc']));

  assert.ok(sql.indexOf('i.account_name') < sql.indexOf('i.item_name DESC'), sql);
});

t('each column carries its own direction', () => {
  const sql = orderFor('i', queue(['name', 'asc'], ['trait', 'desc']));

  assert.match(sql, /i\.item_name ASC/);
  assert.match(sql, /i\.trait DESC/);
});

t('a row with nothing in the column sinks whichever way it runs', () => {
  for (const dir of ['asc', 'desc']) {
    const sql = orderFor('i', queue(['trait', dir]));

    assert.ok(
      sql.indexOf("i.trait IS NULL OR i.trait = ''") < sql.indexOf(`i.trait ${dir.toUpperCase()}`),
      dir
    );
  }
});

t('a column the list does not have never reaches the query', () => {
  assert.doesNotMatch(orderFor('i', queue(['mail', 'asc'])), /mail/);
});

t('rows the queue cannot separate keep a stable order', () => {
  assert.match(orderFor('i', []), /i\.item_name ASC, i\.account_name ASC, i\.id ASC$/);
});

t('the offering table can be ordered without a location column', () => {
  const sql = orderFor('a', queue(['name', 'asc']).filter((entry) => entry.field !== 'location'));

  assert.match(sql, /a\.item_name ASC/);
});

// ------------------------------------------------------------- the headings

const request = (filters) => inventoryTable(rows, { mine: false, filters });
const offering = (filters) => inventoryTable(rows, { mine: true, filters });

t('every column that can decide the order is a heading that sorts', () => {
  const html = request({});

  for (const field of ['name', 'added', 'type', 'trait', 'owner']) {
    assert.match(html, new RegExp(`data-sort="${field}"`), field);
  }
});

t('location sorts on Offering, where the column is drawn', () => {
  assert.match(offering({}), /data-sort="location"/);
  assert.doesNotMatch(request({}), /data-sort="location"/, 'Request keeps others’ bags to itself');
});

t('an active heading carries its place as a superscript before the arrow', () => {
  const html = request({ order: queue(['name', 'asc'], ['trait', 'desc']) });

  assert.match(html, /<sup class="sort-rank">1<\/sup>\u25b2/);
  assert.match(html, /<sup class="sort-rank">2<\/sup>\u25bc/);
});

t('a heading that is off carries no badge', () => {
  const html = request({ order: queue(['name', 'asc']) });

  assert.match(html, /<span class="sort-queue" hidden><\/span>/);
  assert.doesNotMatch(html, /<sup class="sort-rank">2<\/sup>/);
});

t('the heading reports the direction and its place to a screen reader', () => {
  const html = request({ order: queue(['name', 'asc'], ['trait', 'desc']) });

  assert.match(html, /aria-sort="ascending"/);
  assert.match(html, /aria-label="Trait, sorted descending, 2 in the sort order"/);
  assert.match(html, /aria-label="Type, not sorted"/);
});

t('the closing table offers the same columns it has', () => {
  const html = offerTable(rows, { mine: false, filters: { order: queue(['owner', 'desc']) } });

  assert.match(html, /data-sort="owner" data-dir="desc"/);
  assert.match(html, /<sup class="sort-rank">1<\/sup>\u25bc/);
});

// ---------------------------------------------------------------- the search

t('a row says what it can be found by', () => {
  const html = offering({});

  assert.match(html, /data-search="Briarheart Dagger Weapons Sharpened Bank 3 @eva"/);
  assert.match(html, /data-search="Ancient Silk Apparel Impenetrable Inventory \(Eva\) @sender2"/);
});

t('Request can be found by the same things, minus the storage place', () => {
  const html = request({});

  assert.match(html, /data-search="Briarheart Dagger Weapons Sharpened @eva"/);
  assert.doesNotMatch(html, /data-search="[^"]*Bank 3[^"]*"/);
});

t('a standing offer has no location to be found by', () => {
  const html = offerTable(rows, { mine: false, filters: {} });

  assert.match(html, /data-search="Briarheart Dagger Weapons Sharpened @eva"/);
});

t('the heading row holds a search box with a cross to clear it', () => {
  const html = listSearchBox();

  assert.match(html, /<input class="list-search-input" id="listSearch" type="search"/);
  assert.match(html, /placeholder="Search this list"/);
  assert.match(html, /data-list-search>/);
  assert.match(html, /aria-label="Search this list"/);
});

t('the cross starts out of the way, and is a button rather than a glyph', () => {
  const html = listSearchBox();

  assert.match(html, /<button class="list-search-clear" type="button" data-list-search-clear/);
  assert.match(html, /aria-label="Clear the search"/);
  assert.match(html, /hidden>&times;<\/button>/);
});

t('the search box is not part of any form, so it cannot be submitted', () => {
  assert.doesNotMatch(listSearchBox(), /<form/);
  assert.doesNotMatch(listSearchBox(), /name="/, 'nothing to post');
});

console.log(`\n${total - failures}/${total} passed`);

process.exit(failures ? 1 : 0);
