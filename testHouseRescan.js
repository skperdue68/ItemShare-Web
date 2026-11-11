#!/usr/bin/env node
// What somebody is told after answering a request for a furnishing that stands in a house.
//
// A placed furnishing is not in any bag, so this site cannot recount it: the row reads
// "Placed (Mournoth Keep)" and stays at whatever the last /ishare scan found, however many
// copies are picked up afterwards. Answering one therefore leaves the site's count stale
// until the owner walks back into that house, scans it and uploads the file - so the first
// such answer in a session says so, once per tab rather than once per row.
//
// The notice is run out of public/app.js against a stand-in page and the card is rendered
// out of lib/views.js, so both halves are checked without a browser or a database.
//
//   npm run test:house-rescan

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderOwnerRequestsCard } from './lib/views.js';

const source = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const store = fs.readFileSync(new URL('./lib/store.js', import.meta.url), 'utf8');

let total = 0;
let failures = 0;

function t(name, fn) {
  total += 1;

  try {
    fn();
    console.log(`ok ${total} - ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n  ${error.message}`);
  }
}

/** The text between two anchors, failing loudly when either has moved. */
function between(start, end) {
  const from = source.indexOf(start);

  if (from < 0) {
    throw new Error(`MISSING ANCHOR in public/app.js: ${start}`);
  }

  const to = source.indexOf(end, from);

  if (to < 0) {
    throw new Error(`MISSING ANCHOR in public/app.js: ${end}`);
  }

  return source.slice(from, to);
}

const noticeSource = between(
  '// ------------------------------------------- placed furnishings, once a session',
  '// ------------------------------------------------------------ leaving the page'
);

const KEY = /const HOUSE_RESCAN_KEY = '([^']+)';/.exec(noticeSource)[1];

/** A page just real enough for the notice: appended to, and queried by selector. */
function page({ remembered = [] } = {}) {
  const created = [];
  const memory = new Map(remembered.map((key) => [key, '1']));
  const fakeDocument = {
    body: { appendChild: () => {} },
    createElement() {
      const element = {
        className: '',
        innerHTML: '',
        removed: false,
        addEventListener: () => {},
        remove() {
          element.removed = true;
        },
        querySelector(selector) {
          if (selector === '[data-house-where]') {
            element.named = { textContent: '' };

            return element.named;
          }

          if (selector === '[data-close-house-rescan]') {
            return { focus: () => {} };
          }

          return null;
        },
      };

      created.push(element);

      return element;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
  };
  const fakeWindow = {
    sessionStorage: {
      getItem: (key) => (memory.has(key) ? memory.get(key) : null),
      setItem: (key, value) => memory.set(key, value),
    },
  };
  const build = new Function(
    'document',
    'window',
    `${noticeSource}\nreturn { noteHouseRescan, showHouseRescanNotice };`
  );

  return { ...build(fakeDocument, fakeWindow), created, memory };
}

/** The card the modal over the list shows after an answer. */
const answered = (label) => ({
  fulfilled: 1,
  cancelled: 0,
  copies: 1,
  rows: [
    {
      id: 1,
      itemName: 'Seal of the Wolf',
      requesterAccount: '@evainefaye',
      asked: 1,
      sent: 1,
      status: 'fulfilled',
      locationLabel: label,
    },
  ],
});

// ------------------------------------------------------------------ what the card says

t('the card names the house when the item that was answered stands in one', () => {
  const card = renderOwnerRequestsCard({ rows: [], answered: answered('Placed (Mournoth Keep)') });

  assert.match(
    card,
    /<p class="status ok" data-house-rescan="Placed \(Mournoth Keep\)">/,
    'the confirmation carries the house'
  );
});

t('an item from a bag says nothing about a house', () => {
  const card = renderOwnerRequestsCard({ rows: [], answered: answered('Bank') });

  assert.equal(card.includes('data-house-rescan'), false);
});

t('no answer, no house', () => {
  assert.equal(
    renderOwnerRequestsCard({ rows: [], answered: null }).includes('data-house-rescan'),
    false
  );
});

t('a house name from a saved file cannot break out of the attribute', () => {
  const label = 'Placed (Odd "House" & Co)';
  const card = renderOwnerRequestsCard({ rows: [], answered: answered(label) });
  const match = /data-house-rescan="([^"]*)"/.exec(card);

  assert.ok(match, 'the attribute is there');

  const decoded = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  assert.equal(decoded, label, 'and reads back as the name it was given');
});

// ------------------------------------------------------------------ what the dialog says

t('the dialog says to scan the house, then save and upload', () => {
  const run = page();

  run.noteHouseRescan('Placed (Mournoth Keep)');

  assert.equal(run.created.length, 1, 'one dialog is put on the page');

  const dialog = run.created[0];

  assert.match(dialog.className, /modal-backdrop/, 'drawn as the site\'s other dialogs are');
  assert.match(dialog.innerHTML, /Scan that house again/);
  assert.match(dialog.innerHTML, /\/ishare scan/, 'the command is the point of it');
  assert.match(dialog.innerHTML, /saved variables file/);
  assert.match(dialog.innerHTML, /upload/, 'the upload is what updates the counts');
  assert.match(dialog.innerHTML, /data-close-house-rescan>Got it</, 'and one way out');
  assert.equal(
    dialog.named.textContent,
    'Placed (Mournoth Keep)',
    'it names the house that has to be scanned'
  );
});

t('the house name is written as text, not as markup', () => {
  const run = page();

  run.noteHouseRescan('<script>x</script>');

  assert.equal(run.created[0].named.textContent, '<script>x</script>');
  assert.equal(run.created[0].innerHTML.includes('<script>'), false);
});

// ------------------------------------------------------------------ once a session

t('the first placed answer in a tab says it, the second does not', () => {
  const run = page();

  run.noteHouseRescan('Placed (Mournoth Keep)');
  run.noteHouseRescan('Placed (Mournoth Keep)');

  assert.equal(run.created.length, 1, 'said once, not on every row');
});

t('the session is what is remembered', () => {
  const run = page();

  run.noteHouseRescan('Placed (Mournoth Keep)');

  assert.equal(run.memory.get(KEY), '1', 'the tab records that it has been told');
});

t('a tab that has already been told stays quiet', () => {
  const run = page({ remembered: [KEY] });

  run.noteHouseRescan('Placed (Mournoth Keep)');

  assert.equal(run.created.length, 0);
});

t('nothing to name means no dialog at all', () => {
  const run = page();

  run.noteHouseRescan('');

  assert.equal(run.created.length, 0);
});

t('storage that refuses still gets the notice', () => {
  const created = [];
  const broken = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
  };
  const fakeDocument = {
    body: { appendChild: () => {} },
    createElement() {
      const element = {
        className: '',
        innerHTML: '',
        addEventListener: () => {},
        remove: () => {},
        querySelector: () => null,
      };

      created.push(element);

      return element;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
  };
  const build = new Function(
    'document',
    'window',
    `${noticeSource}\nreturn { noteHouseRescan };`
  );

  build(fakeDocument, { sessionStorage: broken }).noteHouseRescan('Placed (Mournoth Keep)');

  assert.equal(created.length, 1, 'a private window is told rather than left guessing');
});

// ------------------------------------------------------------------ the wiring

t('answering a request reads the house off the card', () => {
  const answer = between('async function answerOwnerRequest(', "document.addEventListener('click'");

  assert.match(answer, /querySelector\('\[data-house-rescan\]'\)/, 'it looks for the house');
  assert.match(
    answer,
    /noteHouseRescan\(placed\.getAttribute\('data-house-rescan'\)\)/,
    'and hands the name to the notice'
  );
});

t('the answer carries the stored-at of the row it answered', () => {
  const passes = store.match(/locationLabel: String\(row\.location_label \|\| ''\)\.trim\(\)/g) || [];

  assert.equal(passes.length, 2, 'both the cancelled and the fulfilled answer');
  assert.match(store, /quantity_requested, trait, enchant_name, location_label/);
});

console.log(`\n${total - failures}/${total} passed`);

process.exit(failures ? 1 : 0);
