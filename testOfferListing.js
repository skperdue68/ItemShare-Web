#!/usr/bin/env node
// Which standing offers draw a row: the owner's own always do once the file wrote a count,
// a guildmate's only while there is a copy to hand over. Renders the real list out of
// lib/views.js - no browser, no database.
//
//   npm run test:offer-listing

import assert from 'node:assert/strict';

import { renderListRegion } from './lib/views.js';

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

function offer(id, extra = {}) {
  return {
    id,
    item_name: `Offer ${id}`,
    item_key_hash: `offer-${id}`,
    item_type_name: 'Weapons',
    trait: 'Sharpened',
    quality: 4,
    held_quantity: 2,
    reserve_quantity: 0,
    location_label: 'Bank 1',
    account_name: '@eva',
    first_seen_at_iso: '2026-11-01T10:00:00Z',
    ...extra,
  };
}

// My Inventory reads `alwaysShare`, Others Inventory reads `requestOffers`; the owner's own
// account is @eva, so an offer on it is theirs.
function region(offers, { mine = true } = {}) {
  return renderListRegion({
    user: { id: 1, username: 'eva', provider: 'password' },
    accounts: [{ accountName: '@eva', guildCount: 1, guilds: [{}] }],
    sharedItems: [],
    requestItems: [],
    alwaysShare: mine ? offers : [],
    requestOffers: mine ? [] : offers,
    facets: { types: [], owners: [] },
    filters: {},
    requests: [],
    basketRows: [],
  });
}

function slice(html, from, to) {
  const start = html.indexOf(from);
  if (start === -1) return '';
  const end = html.indexOf(to, start);
  return html.slice(start, end === -1 ? undefined : end);
}

const offerPanel = (html) => slice(html, 'id="panelOffer"', 'id="panelMine"');
const requestPanel = (html) => slice(html, 'id="panelRequest"', 'id="panelOffer"');
const ownOffersHeading = '<h3 class="subhead list-sticky">Your standing offers</h3>';
const othersOffersHeading = '<h3 class="subhead list-sticky">Standing offers</h3>';
const offeredTabCount = (html) => {
  const tab = slice(html, 'id="tabOffer"', '</button>');
  return Number((tab.match(/tab-count">(\d+)/) || [])[1]);
};

// ------------------------------------------------------------ the owner's own offers

t('an offer holding nothing is still a row on My Inventory', () => {
  const html = region([offer(1, { held_quantity: 0 })]);

  assert.ok(offerPanel(html).includes(ownOffersHeading), 'the section is drawn');
  assert.match(offerPanel(html), /data-item-key="offer:offer-1"/);
});

t('that row says zero offered and zero available', () => {
  const row = slice(
    offerPanel(region([offer(1, { held_quantity: 0 })])),
    'data-item-key="offer:offer-1"',
    '</tr>'
  );

  assert.equal([...row.matchAll(/<td class="num">0<\/td>/g)].length, 2, 'OFFERED and AVAILABLE');
  assert.doesNotMatch(row, /class="num held-cell">\d/, 'nothing is reserved');
});

t('an empty offer keeps its place, so the column still says where it counts from', () => {
  const row = slice(
    offerPanel(region([offer(1, { held_quantity: 0, location_label: 'Inventory (Eva)' })])),
    'data-item-key="offer:offer-1"',
    '</tr>'
  );

  assert.match(row, /<td class="location-cell">Inventory \(Eva\)<\/td>/);
  assert.match(row, />Weapons<\/td>/);
  assert.match(row, />Sharpened<\/td>/);
});

t('the tab counts an offer that is holding nothing', () => {
  assert.equal(offeredTabCount(region([offer(1, { held_quantity: 0 })])), 1);
  assert.equal(offeredTabCount(region([offer(1, { held_quantity: 0 }), offer(2)])), 2);
});

t('an empty offer offers nobody a Reserve button', () => {
  assert.doesNotMatch(offerPanel(region([offer(1, { held_quantity: 0 })])), /Reserve one/);
});

t('an offer the file wrote no count for is not a row, even for its owner', () => {
  const html = region([offer(1, { held_quantity: null })]);

  assert.doesNotMatch(html, /data-item-key="offer:offer-1"/);
  assert.equal(offeredTabCount(html), 0);
});

t('an offer every copy of which is spoken for keeps its row for its owner', () => {
  const html = region([offer(1, { held_quantity: 2, reserved: 2 })]);

  assert.match(offerPanel(html), /data-item-key="offer:offer-1"/);
});

// -------------------------------------------------------- somebody else's offers

t('an empty offer is not on Others Inventory', () => {
  const html = region([offer(1, { held_quantity: 0, account_name: '@sender2' })], { mine: false });

  assert.doesNotMatch(requestPanel(html), /data-item-key="offer:offer-1"/);
  assert.ok(!requestPanel(html).includes(othersOffersHeading), 'no empty section either');
});

t('an offer with a copy to hand over is on Others Inventory', () => {
  const html = region([offer(1, { account_name: '@sender2' })], { mine: false });

  assert.ok(requestPanel(html).includes(othersOffersHeading));
  assert.match(requestPanel(html), /data-item-key="offer:offer-1"/);
  assert.match(requestPanel(html), /Reserve one/);
});

t('Others Inventory keeps the owner’s storage to itself', () => {
  const html = region([offer(1, { account_name: '@sender2' })], { mine: false });

  assert.doesNotMatch(requestPanel(html), /location-cell/);
});

console.log(`\n${total - failures}/${total} passed`);

process.exit(failures ? 1 : 0);
