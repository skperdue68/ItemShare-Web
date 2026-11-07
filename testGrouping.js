#!/usr/bin/env node
// The grouping switch: what it draws, what it says, and what the list looks like either
// way. Renders the real table out of lib/views.js - no browser, no database - so a change
// that quietly ties the headings back to the sort order fails here instead of in the list.
//
//   npm run test:grouping

import assert from 'node:assert/strict';

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
  const html = render({ sort: 'name', group: false });
  const order = ['Briarheart Dagger', 'Ancient Silk', 'Cuirass', 'Hunting Bow'].map((name) =>
    html.indexOf(name)
  );

  assert.ok(order.every((at) => at > -1), 'every row is there');
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, 'rows stay in list order');
});

t('sorting alphabetically no longer turns grouping off', () => {
  assert.equal(headingCount(render({ sort: 'name', group: true })), 2);
});

t('sorting by date no longer turns grouping off', () => {
  assert.equal(headingCount(render({ sort: 'added', group: true })), 2);
});

t('the headings still go when grouping is off and the sort is by type', () => {
  assert.equal(headingCount(render({ sort: 'type', group: false })), 0);
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

console.log(`\n${total - failures}/${total} passed`);

process.exit(failures ? 1 : 0);
