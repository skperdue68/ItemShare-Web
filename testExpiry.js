#!/usr/bin/env node
// Expiry: what the upload's expireDays becomes, what the list draws for it, and what the
// Added menu offers. Reads the real parser and renders the real table out of lib/views.js -
// no browser, no database.
//
//   npm run test:expiry

import assert from 'node:assert/strict';

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
                ["worldName"] = "NA Megaserver",${scopeExtra}
                ["sharedItems"] =
                {
                    [1] =
                    {
                        ["itemName"] = "Ring of the Gorethief",
                        ["itemLink"] = "|H1:item:12345:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0|h|h",
                        ["itemTypeName"] = "Apparel",
                        ["count"] = 1,
                        ["firstDumpedAt"] = 1794000000,
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

t('a single choice has no count badge', () => {
  const added = bar.slice(bar.indexOf('aria-label="Added"'));
  const summary = added.slice(0, added.indexOf('</summary>'));

  assert.doesNotMatch(summary, /filter-count/, 'one value is not a count');
  assert.match(
    bar.slice(0, bar.indexOf('aria-label="Added"')),
    /filter-count/,
    'Type still counts its several values'
  );
});

t('the filter card has no item name box and says Reset', () => {
  assert.doesNotMatch(bar, /name="q"/);
  assert.doesNotMatch(bar, /Item name/);
  assert.match(bar, />RESET</);
  assert.doesNotMatch(bar, /Clear filters/);
});

t('a chosen window is reported by its own label', () => {
  const chosen = filterBar({ types: [], owners: [] }, { added: 'last-chance' });

  assert.match(chosen, /filter-select-label">LAST CHANCE</, 'not the raw last-chance value');
  assert.match(chosen, /value="last-chance" checked/);
});

console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) {
  process.exit(1);
}
