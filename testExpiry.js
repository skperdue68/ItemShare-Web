#!/usr/bin/env node
// Expiry: what the upload's expireDays becomes, what the list draws for it, and what the
// Added menu offers. Reads the real parser and renders the real table out of lib/views.js -
// no browser, no database.
//
//   npm run test:expiry

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { extractShareData } from './lib/savedVars.js';
import { filterBar, inventoryTable } from './lib/views.js';

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

function file(scopeExtra) {
  return `ItemShareSavedVars =
{
    ["Default"] =
    {
        ["@Tester"] =
        {
            ["$AccountWide"] =
            {
                ["platformRaw"] = 2,
                ["worldName"] = "NA Megaserver",
                ["itemFirstDumped"] =
                {
                    ["|H1:item:12345:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0|h|h"] = 1794000000,
                },${scopeExtra}
                ["sharedItems"] =
                {
                    [1] =
                    {
                        ["itemName"] = "Ring of the Gorethief",
                        ["itemLink"] = "|H1:item:12345:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0|h|h",
                        ["itemTypeName"] = "Apparel",
                        ["count"] = 1,
                        ["lastDumpedAt"] = 1794000000,
                    },
                },
            },
        },
    },
}
`;
}

function item(extra = {}) {
  return {
    id: 1,
    item_key_hash: 'abc',
    item_name: 'Ring of the Gorethief',
    item_type_name: 'Apparel',
    item_count: 1,
    held_quantity: 1,
    reserve_quantity: 0,
    quality: 5,
    trait: 'Robust',
    location_label: 'Bank',
    account_name: '@Tester',
    first_seen_at_iso: '2026-10-01T10:00:00Z',
    guild_names: 'Guild',
    ...extra,
  };
}

const render = (extra) => inventoryTable([item(extra)], { mine: false, filters: {} });

// ------------------------------------------------------------------ the file

t('expireDays is read per account', () => {
  const parsed = extractShareData(file('\n                ["expireDays"] = 14,'));

  assert.equal(parsed.accountExpiryDays.get('@Tester'), 14);
});

t('a file with no expireDays expires nothing', () => {
  const parsed = extractShareData(file(''));

  assert.equal(parsed.accountExpiryDays.size, 0, 'no window is invented');
});

t('a nonsense expireDays is clamped rather than trusted', () => {
  assert.equal(extractShareData(file('\n                ["expireDays"] = -3,')).accountExpiryDays.size, 0);
  assert.equal(
    extractShareData(file('\n                ["expireDays"] = 999999,')).accountExpiryDays.get('@Tester'),
    3650
  );
});

// ------------------------------------------------------- where the date lives now

// 1.11.39 keeps the date once per item link, beside the item list, and clears the copy on
// the row. Two places keeping the same item are one offer, so both rows report one day -
// and a row whose link is not in the table reports nothing rather than borrowing a date.
function fileWithTable(tableBody) {
  return `ItemShareSavedVars =
{
    ["Default"] =
    {
        ["@Tester"] =
        {
            ["$AccountWide"] =
            {
                ["platformRaw"] = 2,
                ["worldName"] = "NA Megaserver",
                ["itemFirstDumped"] = { ${tableBody} },
                ["sharedItems"] =
                {
                    [1] =
                    {
                        ["itemName"] = "Ring of the Gorethief",
                        ["itemLink"] = "|H1:item:12345:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0|h|h",
                        ["locationKey"] = "bank",
                        ["count"] = 1,
                    },
                    [2] =
                    {
                        ["itemName"] = "Ring of the Gorethief",
                        ["itemLink"] = "|H1:item:12345:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0|h|h",
                        ["locationKey"] = "house",
                        ["sharedFrom"] = "Placed (Mournoth Keep)",
                        ["count"] = 1,
                    },
                },
            },
        },
    },
}
`;
}

t('every row of a link reports the day the item was first offered', () => {
  const link = extractShareData(file('')).items[0].itemLink;
  const parsed = extractShareData(fileWithTable(`["${link}"] = 1700000000,`));

  assert.equal(parsed.items.length, 2, 'both places were read');
  assert.deepEqual(
    parsed.items.map((row) => row.firstDumpedAt),
    [1700000000, 1700000000],
    'the bank copy and the house copy agree, and neither is 0'
  );
});

t('the date comes from the table, not from a copy left on the row', () => {
  const parsed = extractShareData(file(''));
  const link = parsed.items[0].itemLink;

  assert.equal(parsed.items[0].firstDumpedAt, 1794000000, 'read from the table');

  const without = extractShareData(file('').replace(link, '|H1:item:999:0|h|h'));

  assert.equal(
    without.items[0].firstDumpedAt,
    0,
    'a link the table does not name is not given another row\'s date'
  );
});

t('the Added cell shows the date the owner\'s file gave the item', () => {
  const html = inventoryTable(
    [item({ added_at_iso: '2025-03-04T05:06:07Z' })],
    { mine: false, filters: {} }
  );

  assert.match(html, /datetime="2025-03-04T05:06:07Z"/, 'the item\'s own date, not today');
  assert.doesNotMatch(html, /datetime="2026-10-01T10:00:00Z"/, 'not the day it reached us');
});

t('a row with no date from the file still shows the day the site saw it', () => {
  const html = inventoryTable([item({})], { mine: false, filters: {} });

  assert.match(html, /datetime="2026-10-01T10:00:00Z"/);
});

// ------------------------------------------------------------------ the row

t('an expiring row carries the pill and its tooltip', () => {
  const html = render({ expiring: 1, expire_days: 14 });

  assert.match(html, /class="last-chance-pill"[^>]*>LAST CHANCE</);
  assert.match(
    html,
    /title="Item has been shared longer than 14 days and is subject to being removed from sharing, act quickly!"/
  );
});

t('the pill is the only change: the row keeps its counts', () => {
  const html = render({ expiring: 1, expire_days: 14 });

  assert.doesNotMatch(html, /class="row-last-chance"/, 'the row is not marked apart');
  assert.doesNotMatch(html, /filter: grayscale|<tr[^>]*style="[^"]*opacity/, 'nothing is dimmed');
  assert.match(html, /<td class="num">1<\/td>/, 'AVAILABLE still says 1');
});

t('a row inside its window is untouched', () => {
  assert.doesNotMatch(render({ expiring: 0, expire_days: 14 }), /last-chance-pill/);
  assert.doesNotMatch(render({}), /last-chance-pill/, 'no expireDays means no flag');
});

// ------------------------------------------------------------------ the filter

const bar = filterBar({ types: [{ name: 'Apparel', total: 1 }], owners: ['@Tester'] }, {});

t('Added is a menu like Type and Offered by, not a dropdown', () => {
  assert.doesNotMatch(bar, /<select name="added"/);
  assert.match(bar, /data-filter-menu data-all-label="Any time"/);
  assert.match(bar, /<span class="filter-label">Added<\/span>/);
});

t('Added holds one choice at a time', () => {
  const added = bar.slice(bar.indexOf('aria-label="Added"'));

  assert.match(added, /<input type="radio" name="added" value="1"/, 'radios, not checkboxes');
  assert.doesNotMatch(added, /type="checkbox" name="added"/);
});

t('LAST CHANCE is the last choice', () => {
  const added = bar.slice(bar.indexOf('aria-label="Added"'), bar.indexOf('</details>', bar.indexOf('aria-label="Added"')));

  assert.match(added, /LAST CHANCE<\/span>/, 'the option is there');
  assert.ok(
    added.indexOf('LAST CHANCE') > added.indexOf('The last 30 days'),
    'and it comes after the windows'
  );
  assert.match(added, /filter-option-warn/, 'drawn as the warning it is');
});

t('the filter card has no item name box and says Reset', () => {
  assert.doesNotMatch(bar, /name="q"/);
  assert.doesNotMatch(bar, /Item name/);
  assert.match(bar, />Reset</);
  assert.doesNotMatch(bar, /Clear filters/);
});

t('a chosen window is reported by its own label', () => {
  const chosen = filterBar({ types: [], owners: [] }, { added: 'last-chance' });

  assert.match(chosen, /filter-select-label">LAST CHANCE</, 'not the raw last-chance value');
  assert.match(chosen, /value="last-chance" checked/);
});

// The markup was right both times and the stylesheet was not: a pill stretched into a bar,
// and a radio dot drawn in a menu that only takes one choice. Neither shows up in rendered
// HTML, so the two rules are read out of the stylesheet itself.
t('the pill fits its words and the Added menu draws no radio dots', () => {
  const css = readFileSync(new URL('./public/styles.css', import.meta.url), 'utf8');

  const start = css.indexOf('.last-chance-pill {');
  assert(start > -1, 'the pill has a rule of its own');
  const pill = css.slice(start, css.indexOf('}', start));
  assert(/align-self:\s*flex-start/.test(pill), 'a flex column stretches it into a bar');
  assert(/white-space:\s*nowrap/.test(pill), 'the two words stay on one line');

  assert(
    /\.filter-option input\[type=['"]radio['"]\]\s*\{/.test(css),
    'the Added menu takes one choice, so its radios are not drawn'
  );
});

console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) {
  process.exit(1);
}
