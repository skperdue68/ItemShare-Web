#!/usr/bin/env node
// The item list's sort queue and the search box above it: what a cookie may hold, what a
// queue turns into as SQL, and what the table and the heading row draw for it. Renders the
// real table out of lib/views.js - no browser, no database.
//
//   npm run test:item-sort

import assert from 'node:assert/strict';
import fs from 'node:fs';

import { SORT_FIELDS, parseSortOrder, queuePlace } from './lib/sortQueue.js';
import { orderFor } from './lib/store.js';
import { inventoryTable, listSearchBox, offerTable, renderListRegion } from './lib/views.js';

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
    // A standing offer fixture stands for a file that wrote no count, which is the one-copy
    // offer these checks were written against; a written 0 would mean the owner holds none.
    held_quantity: null,
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

  assert.match(html, /<input class="list-search-input" id="listSearch-request" type="search"/);
  assert.match(html, /placeholder="Search this list"/);
  assert.match(html, /data-list-search="request">/);
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

t('the search shares the row with the grouping switch', () => {
  const region = renderListRegion({
    user: { id: 1, username: 'eva', provider: 'password' },
    accounts: [{ accountName: '@eva', guildCount: 1, guilds: [{}] }],
    sharedItems: [],
    requestItems: [item(2, 'Ancient Silk', 'Apparel', { account_name: '@sender2' })],
    alwaysShare: [],
    requestOffers: [],
    facets: { types: [{ name: 'Apparel', total: 1 }], owners: ['@sender2'] },
    filters: {},
    requests: [],
    basketRows: [],
  });

  const panel = region.indexOf('id="panelRequest"');
  const tools = region.indexOf('<div class="list-tools">');
  const search = region.indexOf('class="list-search"');
  const toggle = region.indexOf('data-group-toggle');

  assert.ok(panel > -1 && tools > -1 && search > -1 && toggle > -1, 'all four are drawn');
  assert.ok(panel < tools, 'the row belongs to the list it narrows');
  assert.ok(tools < search && search < toggle, 'the box and the switch share the row, box first');
  assert.equal(region.indexOf('class="list-search"', search + 1), -1, 'one box for the tab');
  assert.match(region, /id="listSearch-request"/);
});

// ------------------------------------------------- the count while searching
// A heading's number is the server's count of the whole group. app.js narrows the rows
// when a term is typed, so it has to narrow the number with them - read out of the real
// source here, so the two cannot drift apart.

const appSource = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');

function appBetween(start, end) {
  const from = appSource.indexOf(start);
  const to = appSource.indexOf(end, from);

  assert.ok(from >= 0 && to > from, `Missing source anchors: ${start}`);
  return appSource.slice(from, to);
}

const searchSource = appBetween(
  '  function applyListSearch(tab = activeTab)',
  '  function updateSearchClear(tab)'
);

function headingRow(count) {
  const countElement = { textContent: `(${count})` };

  return {
    classList: { contains: (name) => name === 'type-row' },
    hidden: false,
    querySelector: (selector) => (selector === '.type-count' ? countElement : null),
    count: countElement,
  };
}

function itemRow(text) {
  return {
    classList: { contains: () => false },
    hidden: false,
    hasAttribute: (name) => name === 'data-search',
    getAttribute: (name) => (name === 'data-search' ? text : null),
  };
}

// Runs app.js's own applyListSearch against the smallest page it can see: one table body,
// the rows in it, and nothing else.
function runSearch(term, rows) {
  const region = {
    querySelectorAll: (selector) => (selector === 'table tbody' ? [{ rows }] : []),
    querySelector: () => null,
  };
  const apply = new Function(
    'listRegion',
    'activeTab',
    'listSearchByTab',
    `${searchSource}; return applyListSearch;`
  )(region, 'request', { request: term, offer: '' });

  apply();

  return rows;
}

t('each heading counts its own group when nothing is being searched', () => {
  const apparel = headingRow(2);
  const weapons = headingRow(1);

  runSearch('', [
    apparel,
    itemRow('Ancient Silk Apparel Impenetrable'),
    itemRow('Cuirass Apparel Reinforced'),
    weapons,
    itemRow('Briarheart Dagger Weapons Sharpened'),
  ]);

  assert.equal(apparel.count.textContent, '(2)');
  assert.equal(weapons.count.textContent, '(1)');
});

t('a search makes the heading count what matched, out of the whole group', () => {
  const weapons = headingRow(2);
  const dagger = itemRow('Briarheart Dagger Weapons Sharpened');
  const ring = itemRow('Amber Ring Weapons Robust');

  runSearch('dagger', [weapons, dagger, ring]);

  assert.equal(dagger.hidden, false, 'the row that matches stays');
  assert.equal(ring.hidden, true, 'the row that does not is hidden');
  assert.equal(weapons.count.textContent, '(1 of 2)', 'one of the two in the group');
});

t('a group with nothing to show loses its heading', () => {
  const apparel = headingRow(2);
  const weapons = headingRow(1);

  runSearch('dagger', [
    apparel,
    itemRow('Ancient Silk Apparel Impenetrable'),
    itemRow('Cuirass Apparel Reinforced'),
    weapons,
    itemRow('Briarheart Dagger Weapons Sharpened'),
  ]);

  assert.equal(apparel.hidden, true, 'no Apparel row matches, so the heading goes');
  assert.equal(weapons.hidden, false);
  assert.equal(weapons.count.textContent, '(1 of 1)');
});

// A word is typed over one tab, so it narrows that one tab. Both tables are in the page all
// the time - one is only hidden - so a pass that walked every body would filter rows its
// word was never meant for.
function panelOf(rows) {
  return {
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === 'table tbody' ? [{ rows }] : []),
  };
}

function runTabSearch(tab, terms, panels) {
  const region = {
    querySelectorAll: () => [],
    querySelector: (selector) => {
      const match = /^\[data-panel="([a-z]+)"\]$/.exec(selector);
      return match ? panels[match[1]] || null : null;
    },
  };
  const apply = new Function(
    'listRegion',
    'activeTab',
    'listSearchByTab',
    `${searchSource}; return applyListSearch;`
  )(region, tab, terms);

  apply();
}

t('a word typed on one tab leaves the other tab alone', () => {
  const requested = [itemRow('Briarheart Dagger Weapons Sharpened'), itemRow('Amber Ring Weapons Robust')];
  const offered = [itemRow('Briarheart Dagger Weapons Sharpened'), itemRow('Amber Ring Weapons Robust')];

  runTabSearch('request', { request: 'dagger', offer: '' }, {
    request: panelOf(requested),
    offer: panelOf(offered),
  });

  assert.equal(requested[0].hidden, false, 'the dagger asked for stays');
  assert.equal(requested[1].hidden, true, 'the ring asked for goes');
  assert.equal(offered[0].hidden, false, 'Offering keeps every row it had');
  assert.equal(offered[1].hidden, false);
});

t('each tab keeps its own word', () => {
  const requested = [itemRow('Briarheart Dagger Weapons Sharpened'), itemRow('Amber Ring Weapons Robust')];
  const offered = [itemRow('Briarheart Dagger Weapons Sharpened'), itemRow('Amber Ring Weapons Robust')];

  runTabSearch('offer', { request: 'dagger', offer: 'ring' }, {
    request: panelOf(requested),
    offer: panelOf(offered),
  });

  assert.equal(offered[1].hidden, false, 'Offering is narrowed by the word typed on it');
  assert.equal(offered[0].hidden, true);
  assert.equal(requested[0].hidden, false, 'Request was not re-run against the other tab word');
  assert.equal(requested[1].hidden, false);
});

t('clearing the search puts the plain totals back', () => {
  const weapons = headingRow(2);
  const dagger = itemRow('Briarheart Dagger Weapons Sharpened');
  const ring = itemRow('Amber Ring Weapons Robust');

  runSearch('dagger', [weapons, dagger, ring]);
  runSearch('', [weapons, dagger, ring]);

  assert.equal(weapons.count.textContent, '(2)');
  assert.equal(dagger.hidden, false);
  assert.equal(ring.hidden, false);
});

t('a term matches a row the heading does not name', () => {
  const weapons = headingRow(2);
  const row = itemRow('Briarheart Dagger Weapons Sharpened');

  runSearch('sharpened', [weapons, row, itemRow('Amber Ring Weapons Robust')]);

  assert.equal(row.hidden, false, 'the trait is in the row text, the heading is not searched');
  assert.equal(weapons.count.textContent, '(1 of 2)');
});

console.log(`\n${total - failures}/${total} passed`);

process.exit(failures ? 1 : 0);
