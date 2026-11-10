#!/usr/bin/env node
// The ESO accounts dialog: what it lets a person change, and how it separates the guilds
// the game reported from the slot a code opened. Renders the real dialog out of
// lib/views.js - no browser, no database.
//
//   npm run test:accounts-modal

import assert from 'node:assert/strict';

import { accountsModal } from './lib/views.js';

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

const user = { username: 'Tester', email: 'tester@example.com', emailVerified: true };
const upload = { uploaded_at: '2026-11-01 10:00:00', source_file: 'ItemShareSavedVars.lua' };

function account(extra = {}) {
  return {
    accountName: '@Tester',
    itemCount: 4,
    guildCount: 2,
    platform: 2,
    worldName: 'NA Megaserver',
    lastUpload: null,
    guilds: [],
    ...extra,
  };
}

const render = (accounts) => accountsModal(accounts, user, []);

// ------------------------------------------------------- nobody has uploaded a file

t('with no uploaded file there is nothing to add, remove or choose', () => {
  const html = render([account()]);

  assert.doesNotMatch(html, /action="\/accounts\/add"/, 'no attaching by hand');
  assert.doesNotMatch(html, /action="\/accounts\/remove"/, 'no removing');
  assert.doesNotMatch(html, /name="platform"/, 'no platform to set');
  assert.doesNotMatch(html, /name="worldName"/, 'no server to set');
  assert.match(html, /Upload <strong>ItemShareSavedVars\.lua<\/strong>/, 'it says how instead');
});

t('an empty dialog points at the upload rather than asking for a name', () => {
  const html = render([]);

  assert.doesNotMatch(html, /action="\/accounts\/add"/);
  assert.match(html, /No ESO account attached yet/);
  assert.match(html, /every ESO account in it is attached for you/);
});

// ------------------------------------------------------- once a file has arrived

t('an uploaded account brings the attach box and the platform choices', () => {
  const html = render([account({ lastUpload: upload })]);

  assert.match(html, /action="\/accounts\/add"/);
  assert.match(html, /name="platform"/);
  assert.match(html, /name="worldName"/);
  assert.match(html, />Attach another account</);
});

t('removing is a destructive button, not a quiet link', () => {
  const html = render([account({ lastUpload: upload })]);

  assert.match(html, /<button class="danger-button" type="submit">Remove<\/button>/);
  assert.doesNotMatch(html, /class="filter-clear" type="submit">Remove</);
});

// ------------------------------------------------------- the two kinds of guild

t('the slot a code opened is drawn as its own item', () => {
  const html = render([
    account({
      lastUpload: upload,
      guilds: [
        { guild_id: 1, guild_name: 'The Game Guild', invited: 0 },
        { guild_id: 2, guild_name: 'The Invited Guild', invited: 1 },
      ],
    }),
  ]);

  const slot = html.slice(html.indexOf('class="account-slot"'));
  const before = html.slice(0, html.indexOf('class="account-slot"'));

  assert.match(slot, /Guild slot from a code/);
  assert.match(slot, /The Invited Guild/, 'the invited guild sits in its own slot');
  assert.doesNotMatch(slot, /The Game Guild/, 'the game guild is not repeated there');
  assert.match(before, /The Game Guild/, 'and is in the list above');
});

t('an account with only an invited guild still shows it', () => {
  const html = render([
    account({
      lastUpload: upload,
      guilds: [{ guild_id: 2, guild_name: 'The Invited Guild', invited: 1 }],
    }),
  ]);

  assert.doesNotMatch(html, /No guilds recorded yet/, 'no empty-list note beside the slot');
  assert.match(html, /Guild slot from a code/);
  assert.match(html, /The Invited Guild/);
});

t('guilds from the game alone carry no slot label', () => {
  const html = render([
    account({
      lastUpload: upload,
      guilds: [{ guild_id: 1, guild_name: 'The Game Guild', invited: 0 }],
    }),
  ]);

  assert.match(html, /The Game Guild/);
  assert.doesNotMatch(html, /Guild slot from a code/);
});

console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) {
  process.exit(1);
}
