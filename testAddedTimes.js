#!/usr/bin/env node
// The age shown in Added, checked without a database: the UTC stamp made from a UNIX
// timestamp, and the wiring that keeps MariaDB's own time zone out of it.
//
//   npm run test:added-times
//
// The bug this guards: MariaDB converts a TIMESTAMP column into the session's time zone
// when it is read, and the query used to format that value and label it Z. On a host six
// hours behind UTC every item looked six hours old the moment it was added. The stamp now
// comes from UNIX_TIMESTAMP, which is the moment itself.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { utcIsoFromEpoch } from './lib/store.js';

let total = 0;
let failures = 0;

function t(name, check) {
  total += 1;

  try {
    check();
    console.log(`ok ${total} - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok ${total} - ${name}`);
    console.error(`  ${error.message}`);
  }
}

const store = readFileSync(new URL('./lib/store.js', import.meta.url), 'utf8');
const database = readFileSync(new URL('./lib/database.js', import.meta.url), 'utf8');

t('a UNIX timestamp becomes the same UTC instant', () => {
  const seconds = 1794197819;

  assert.equal(utcIsoFromEpoch(seconds), '2026-11-09T04:16:59Z');
  assert.equal(utcIsoFromEpoch(String(seconds)), '2026-11-09T04:16:59Z', 'a string is fine too');
});

t('the stamp is the moment itself, not the server clock', () => {
  const now = Math.floor(Date.now() / 1000);

  // An item added this second reads as this second. A wall clock labelled Z would land
  // whole hours away, which is exactly what the six-hour bug looked like.
  const stamp = utcIsoFromEpoch(now);
  const elapsed = (Date.parse(stamp) - now * 1000) / 1000;

  assert.equal(elapsed, 0, `the stamp is ${elapsed}s from the moment it names`);
  assert.ok(stamp.endsWith('Z'), 'the stamp says it is UTC');
});

t('nothing to stamp is an empty cell, not 1970', () => {
  assert.equal(utcIsoFromEpoch(null), '');
  assert.equal(utcIsoFromEpoch(undefined), '');
  assert.equal(utcIsoFromEpoch('later'), '');
  assert.equal(utcIsoFromEpoch(0), '', 'zero means never stamped, not 1970');
  assert.equal(utcIsoFromEpoch(''), '');
});

t('both lists ask for the instant, and neither formats the column', () => {
  assert.match(store, /UNIX_TIMESTAMP\(i\.first_seen_at\) AS first_seen_at_epoch/);
  assert.match(store, /UNIX_TIMESTAMP\(a\.first_seen_at\) AS first_seen_at_epoch/);
  assert.doesNotMatch(store, /DATE_FORMAT\(\s*[ia]\.first_seen_at/);
  assert.equal(
    (store.match(/, withAddedInstant\(rows\)/g) || []).length,
    2,
    'each list stamps its rows'
  );
});

t('the driver reads a date column as UTC, not as the server clock', () => {
  // The comma keeps the doc comment above the helper out of the count.
  assert.equal(
    (database.match(/timezone: '\+00:00',/g) || []).length,
    2,
    'both the migrating and the per-request connection'
  );
});

t('every connection the site opens is in UTC', () => {
  assert.match(database, /SET time_zone = '\+00:00'/);
  assert.equal(
    (database.match(/await useUtcSession\(connection\)/g) || []).length,
    2,
    'both the migrating and the per-request connection'
  );
});

// ------------------------------------------------------------ the age itself
// The countdown is run out of public/app.js rather than copied, so what is checked is the
// text the page really writes.
const appSource = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const relativeSource = appSource.slice(
  appSource.indexOf('const RELATIVE_TICK_MS = 1000;'),
  appSource.indexOf('// ------------------------------------------------------- end relative times')
);

if (!relativeSource.startsWith('const RELATIVE_TICK_MS')) {
  throw new Error('MISSING ANCHOR in public/app.js: the relative-time block');
}

const { relativeText } = new Function(`${relativeSource}\nreturn { relativeText };`)();

const born = new Date('2026-11-11T07:29:30Z');
const after = (seconds) => new Date(born.getTime() + seconds * 1000);

t('the seconds are written even when they are zero', () => {
  assert.equal(relativeText(born, after(0)), 'just now');
  assert.equal(relativeText(born, after(2)), '02s');
  assert.equal(relativeText(born, after(52)), '52s');
  assert.equal(relativeText(born, after(60)), '01m 00s');
  assert.equal(relativeText(born, after(61)), '01m 01s');
  assert.equal(relativeText(born, after(3600)), '01h 00s');
  assert.equal(relativeText(born, after(86400)), '01d 00s');
});

t('a count never loses its last field, at any age', () => {
  for (let seconds = 0; seconds <= 400000; seconds += 7) {
    const text = relativeText(born, after(seconds));

    if (seconds === 0) {
      assert.equal(text, 'just now');
      continue;
    }

    assert.match(text, /(^| )\d{2}s$/, `${seconds}s read as "${text}"`);

    for (const part of text.split(' ')) {
      assert.match(part, /^\d{2}(y|mo|d|h|m|s)$/, `"${part}" in "${text}" is not two digits`);
    }
  }
});

console.log(`\n${total - failures}/${total} passed`);

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
