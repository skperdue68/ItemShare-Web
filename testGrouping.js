#!/usr/bin/env node
// The grouping switch: what it draws, what it says, and what the list looks like either
// way. Renders the real table out of lib/views.js - no browser, no database - so a change
// that quietly ties the headings back to the sort order fails here instead of in the list.
//
//   npm run test:grouping

import assert from 'node:assert/strict';
import fs from 'node:fs';

import { filterList } from './lib/filters.js';
import { SORT_FIELDS, parseSortOrder } from './lib/sortQueue.js';
import { readCookie, readGrouping } from './lib/preferences.js';
import { groupToggle, inventoryTable } from './lib/views.js';

function item(id, name, type, count) {
  return {
    id,
    item_name: name,
    item_type_name: type,
    item_count: count,
    held_quantity: 0,
    reserve_quantity: 0,
    quality: 4,
    trait: '',
    location_label: '',
    account_name: '@Owner',
    first_seen_at_iso: '2026-11-01T10:00:00Z',
  };
}

const items = [
  item(1, 'Briarheart Dagger', 'Weapons', 3),
  item(2, 'Ancient Silk', 'Apparel', 2),
  item(3, 'Cuirass', 'Apparel', 1),
  item(4, 'Hunting Bow', 'Weapons', 5),
];

const headingCount = (html) => (html.match(/class="type-row"/g) || []).length;
const render = (filters) => inventoryTable(items, { mine: false, filters });
const rects = (html) => (html.match(/<rect/g) || []).length;

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

// ------------------------------------------------------------------ the list itself

t('grouping is on by default, and says so', () => {
  const html = render({});

  assert.equal(headingCount(html), 2, 'one heading per type');
  assert.match(html, /data-group-toggle aria-pressed="true"/);
  assert.match(html, /Grouped by type/);
});

t('each heading counts the rows under it', () => {
  const html = render({});

  assert.match(html, /Apparel <span class="type-count">\(2\)<\/span>/);
  assert.match(html, /Weapons <span class="type-count">\(2\)<\/span>/);
});

t('turning grouping off leaves one list with no headings', () => {
  const html = render({ group: false });

  assert.equal(headingCount(html), 0);
  assert.match(html, /data-group-toggle aria-pressed="false"/);
  assert.match(html, /One list/);
});

t('grouping off keeps the order it was given', () => {
  const html = render({ order: [{ field: 'name', dir: 'asc' }], group: false });
  const order = ['Briarheart Dagger', 'Ancient Silk', 'Cuirass', 'Hunting Bow'].map((name) =>
    html.indexOf(name)
  );

  assert.ok(order.every((at) => at > -1), 'every row is there');
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, 'rows stay in list order');
});

t('sorting alphabetically no longer turns grouping off', () => {
  assert.equal(headingCount(render({ order: [{ field: 'name', dir: 'asc' }], group: true })), 2);
});

t('sorting by date no longer turns grouping off', () => {
  assert.equal(headingCount(render({ order: [{ field: 'added', dir: 'asc' }], group: true })), 2);
});

t('the headings still go when grouping is off and the sort is by type', () => {
  assert.equal(headingCount(render({ order: [{ field: 'type', dir: 'asc' }], group: false })), 0);
});

t('there is one switch, and it is a button', () => {
  const html = render({});

  assert.equal((html.match(/data-group-toggle/g) || []).length, 1);
  assert.match(html, /<button class="group-toggle" type="button"/);
});

// --------------------------------------------------------------------- the picture

t('the picture for grouping shows headings over their rows', () => {
  const html = groupToggle({ group: true });

  assert.equal(rects(html), 4, 'two headings and two indented rows');
  assert.match(html, /opacity="0.55"/, 'the rows sit back from the headings');
  assert.match(html, /aria-hidden="true"/, 'the picture is not read out');
});

t('the picture for one list is equal rows', () => {
  const html = groupToggle({ group: false });

  assert.equal(rects(html), 3, 'no heading, just rows');
  assert.doesNotMatch(html, /opacity="0.55"/, 'nothing is set back');
  assert.match(html, /aria-hidden="true"/);
});

t('the words flip with the state', () => {
  assert.match(groupToggle({ group: true }), /Grouped by type<\/span>/);
  assert.match(groupToggle({ group: false }), /One list<\/span>/);
});

// ------------------------------------------------------------------- the preference

t('a missing grouping cookie means grouped', () => {
  assert.equal(readGrouping(''), true);
  assert.equal(readGrouping(undefined), true);
  assert.equal(readGrouping('1'), true);
});

t('only a deliberate zero turns grouping off', () => {
  assert.equal(readGrouping('0'), false);
  assert.equal(readGrouping('off'), true, 'junk keeps the list as it was');
});

t('one cookie can be read out of a header without the others', () => {
  const header = 'a=1; itemshare_group=0; itemshare_sort=name%3Adesc';

  assert.equal(readCookie(header, 'itemshare_group'), '0');
  assert.equal(readCookie(header, 'itemshare_sort'), 'name:desc');
  assert.equal(readCookie(header, 'missing'), '');
  assert.equal(readCookie('', 'itemshare_group'), '');
});

// ------------------------------------------------- sorting with the groups kept on

// The rows arrive already in the order the query asked for; the table buckets them by type
// and must leave that order alone inside each bucket. These feed an order that looks like
// the result of a name sort and check it survives the bucketing.
const sorted = [
  item(11, 'Amber Ring', 'Weapons', 1),
  item(12, 'Birch Cup', 'Apparel', 1),
  item(13, 'Zephyr Bow', 'Weapons', 1),
  item(14, 'Yew Log', 'Apparel', 1),
];

t('a chosen order is kept inside each group, and the groups stay', () => {
  const html = inventoryTable(sorted, {
    mine: false,
    filters: { order: [{ field: 'name', dir: 'asc' }], group: true },
  });

  assert.equal(headingCount(html), 2, 'the headings are still drawn');
  assert.ok(
    html.indexOf('Amber Ring') < html.indexOf('Zephyr Bow'),
    'the weapons keep the order they arrived in'
  );
  assert.ok(
    html.indexOf('Birch Cup') < html.indexOf('Yew Log'),
    'so do the apparel rows'
  );
});

t('the same order runs straight through when the groups are off', () => {
  const html = inventoryTable(sorted, {
    mine: false,
    filters: { order: [{ field: 'name', dir: 'asc' }], group: false },
  });
  const positions = ['Amber Ring', 'Birch Cup', 'Zephyr Bow', 'Yew Log'].map((name) =>
    html.indexOf(name)
  );

  assert.equal(headingCount(html), 0);
  assert.deepEqual(positions.slice().sort((a, b) => a - b), positions, 'one run, no regrouping');
});

t('a date order is kept inside each group too', () => {
  const html = inventoryTable(sorted, {
    mine: false,
    filters: { order: [{ field: 'added', dir: 'asc' }], group: true },
  });

  assert.equal(headingCount(html), 2);
  assert.ok(html.indexOf('Amber Ring') < html.indexOf('Zephyr Bow'));
  assert.ok(html.indexOf('Birch Cup') < html.indexOf('Yew Log'));
});

t('the sort heading still reports which way it is', () => {
  const html = render({ order: [{ field: 'name', dir: 'desc' }], group: true });

  assert.match(html, /data-sort="name" data-dir="desc"/, 'the arrow and the aria-sort follow');
  assert.equal(headingCount(html), 2, 'and sorting does not take the groups away');
});

// --------------------------------------- the server keeps the two choices apart

// The page only draws what the server asked for, so "does sorting take the groups away?"
// is really a question about readFilters, the one place that turns the two cookies into
// the two answers. These run that function out of server.js with nothing else attached.
const serverSource = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');

/** One function's source, found by name and closed by counting braces. */
function sourceOf(name) {
  const at = serverSource.indexOf('function ' + name + '(');

  if (at < 0) {
    throw new Error('MISSING ANCHOR: function ' + name + ' in server.js');
  }

  let depth = 0;

  for (let i = serverSource.indexOf('{', at); i < serverSource.length; i += 1) {
    if (serverSource[i] === '{') depth += 1;
    if (serverSource[i] === '}') depth -= 1;
    if (depth === 0) return serverSource.slice(at, i + 1);
  }

  throw new Error('unbalanced function ' + name);
}

// The columns the item list sorts by live in lib/sortQueue.js now, so the harness hands
// readFilters the same parser the server imports instead of the constant it used to hold.
const consts = serverSource.match(/const ADDED_WINDOWS = new Set\(\[[^\]]*\]\);/g) || [];

if (consts.length !== 1) {
  throw new Error('MISSING ANCHOR: ADDED_WINDOWS in server.js');
}

const readFilters = new Function(
  'readGrouping',
  'filterList',
  'parseSortOrder',
  'SORT_FIELDS',
  [consts[0], sourceOf('readParam'), sourceOf('readFilters'), 'return readFilters;'].join('\n')
)(readGrouping, filterList, parseSortOrder, SORT_FIELDS);

t('choosing a sort leaves grouping alone', () => {
  const filters = readFilters({}, 'name:asc', '');

  assert.deepEqual(filters.order, [{ field: 'name', dir: 'asc' }], 'the queue is what was asked for');
  assert.equal(filters.group, true, 'and the headings stay on');
});

t('grouping off survives a sort being chosen', () => {
  const filters = readFilters({}, 'added:desc', '0');

  assert.deepEqual(filters.order, [{ field: 'added', dir: 'desc' }]);
  assert.equal(filters.group, false, 'off stays off');
});

t('with neither chosen the list is grouped and ordered by type', () => {
  const filters = readFilters({}, '', '');

  assert.deepEqual(filters.order, [], 'no heading carries a badge until one is pressed');
  assert.equal(filters.group, true);
});

t('a second heading joins the end of the queue', () => {
  const filters = readFilters({}, 'name:asc,type:desc', '');

  assert.deepEqual(filters.order, [
    { field: 'name', dir: 'asc' },
    { field: 'type', dir: 'desc' },
  ]);
});

t('a ?sort= bookmark is still a queue of one', () => {
  const filters = readFilters({ sort: 'added', dir: 'desc' }, 'name:asc', '');

  assert.deepEqual(filters.order, [{ field: 'added', dir: 'desc' }], 'the address bar wins');
});

t('a nonsense grouping cookie does not ungroup the list', () => {
  assert.equal(readFilters({}, 'type:asc', 'nonsense').group, true);
});

t('both list routes read the grouping cookie', () => {
  const reads = (serverSource.match(/readCookie\(req\.headers\.cookie, GROUP_COOKIE\)/g) || []).length;

  assert.equal(reads, 2, 'the page load and the live refresh both pass it through');
});

// ------------------------------------------------ the headings keep their own order

t('the types always run A-Z, whatever the sort did to the rows', () => {
  const html = render({ order: [{ field: 'added', dir: 'desc' }] });
  const order = ['Apparel', 'Weapons'].map((name) =>
    html.indexOf(name + ' <span class="type-count">')
  );

  assert.ok(order[0] > 0 && order[1] > 0, 'both headings are drawn');
  assert.ok(
    order[0] < order[1],
    'Apparel still comes first when the newest row belongs to Weapons'
  );
});

t('three types arrive alphabetically however the rows arrive', () => {
  const rows = [
    item(21, 'Zeta Blade', 'Weapons', 1),
    item(22, 'Apple Pie', 'Consumables', 1),
    item(23, 'Yew Staff', 'Weapons', 1),
    item(24, 'Amber Ring', 'Apparel', 1),
  ];
  const html = inventoryTable(rows, { mine: false, filters: { group: true } });
  const positions = ['Apparel', 'Consumables', 'Weapons'].map((name) =>
    html.indexOf(name + ' <span class="type-count">')
  );

  assert.ok(positions.every((at) => at > 0), 'all three headings are drawn');
  assert.deepEqual(
    positions.slice().sort((a, b) => a - b),
    positions,
    'Apparel, Consumables, Weapons'
  );
});

t('the order inside a type is still the one that was chosen', () => {
  const rows = [
    item(31, 'Zeta Blade', 'Weapons', 1),
    item(32, 'Amber Ring', 'Apparel', 1),
    item(33, 'Yew Staff', 'Weapons', 1),
  ];
  const html = inventoryTable(rows, {
    mine: false,
    filters: { group: true, order: [{ field: 'name', dir: 'asc' }] },
  });

  assert.ok(
    html.indexOf('Zeta Blade') < html.indexOf('Yew Staff'),
    'the weapons keep the order they arrived in'
  );
  assert.ok(
    html.indexOf('Apparel <span') < html.indexOf('Weapons <span'),
    'while the types stay A-Z'
  );
});

console.log(`\n${total - failures}/${total} passed`);

process.exit(failures ? 1 : 0);
