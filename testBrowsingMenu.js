#!/usr/bin/env node
// The account picker above the tabs: the same menu the filters use.
//
// It used to be a native <select>, and the list a browser draws for one is not this site's
// to style - no dark card, no row that lightens under the pointer, no rounded corners - so
// it never matched the Added menu however its closed box was coloured. These checks hold
// the markup to the filters' own classes, so the two cannot drift apart again, and to a
// plain form post for the reader whose browser runs no scripts.
//
//   npm run test:browsing-menu

import assert from 'node:assert/strict';

import { renderListRegion } from './lib/views.js';

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

const base = {
  user: { id: 7, username: 'Tester', provider: 'password' },
  providers: [],
  accounts: [{ accountName: '@fresh', guildCount: 0, guilds: [] }],
  browsingAccount: '@fresh',
  sharedItems: [],
  requestItems: [],
  alwaysShare: [],
  requestOffers: [],
  facets: { types: [], owners: [] },
  filters: {},
  requests: [],
  basketRows: [],
  basket: { count: 0, quantity: 0, secondsLeft: 0, holdMinutes: 30 },
};

const twoAccounts = [
  { accountName: '@fresh', guildCount: 1, guilds: [{ guildName: 'Alphabet Mafia' }] },
  { accountName: '@alt', guildCount: 0, guilds: [] },
];

const regionFor = (extra = {}) => renderListRegion({ ...base, ...extra });

// ------------------------------------------------------------------- the markup

await t('the picker is the filter menu, down to the classes it is drawn with', () => {
  const html = regionFor({ accounts: twoAccounts, browsingAccount: '@alt' });

  assert.match(html, /<div class="filter-menu browsing-dropdown">/);
  assert.match(html, /<details class="filter-dropdown" data-browsing-menu>/);
  assert.match(html, /<summary class="filter-select"/);
  assert.match(html, /<div class="filter-menu-list" role="radiogroup" aria-label="Browsing as">/);
  assert.match(html, /<label class="filter-option">/);
});

await t('nothing is left of the native dropdown', () => {
  const html = regionFor({ accounts: twoAccounts });

  assert.doesNotMatch(html, /<select/);
  assert.doesNotMatch(html, /browsingAccount/);
});

await t('the account being browsed as is the one already chosen', () => {
  const html = regionFor({ accounts: twoAccounts, browsingAccount: '@alt' });

  assert.match(html, /<span class="filter-select-label">@alt<\/span>/);
  assert.match(html, /value="@alt" checked data-browsing-account/);
  assert.equal(
    (html.match(/type="radio" name="accountName"/g) || []).length,
    2,
    'one radio per account, and no checkboxes'
  );
});

await t('the picker is a form post, so it still works with no scripts', () => {
  const html = regionFor({ accounts: twoAccounts });

  assert.match(html, /<form class="browsing-picker" method="post" action="\/browsing-account">/);
  assert.match(
    html,
    /<noscript><button class="browsing-go" type="submit">Switch<\/button><\/noscript>/
  );
  assert.match(html, /name="accountName"/);
  assert.match(html, /Requests will be made on behalf of this account/);
});

await t('the menu says what it is to somebody who cannot see it', () => {
  const html = regionFor({ accounts: twoAccounts });

  assert.match(html, /<span class="browsing-label" id="browsingLabel">Browsing as<\/span>/);
  assert.match(html, /aria-labelledby="browsingLabel"/);
  assert.match(html, /role="radiogroup" aria-label="Browsing as"/);
});

await t('one account is still a sentence rather than a menu', () => {
  const html = regionFor();

  assert.match(html, /browsing-picker browsing-single/);
  assert.match(html, /Browsing as <strong>@fresh<\/strong>/);
  assert.doesNotMatch(html, /browsing-dropdown/);
});

console.log(`\n${total - failures}/${total} checks passed`);
process.exitCode = failures === 0 ? 0 : 1;
