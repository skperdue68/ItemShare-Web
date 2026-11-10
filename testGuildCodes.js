#!/usr/bin/env node
// Guild codes: the eight characters one member hands to another, and the two pages that
// make and take them.
//
// The format is checked on its own - what a code is made of, what a typo is forgiven and
// what it is not - and then the real page markup is rendered and read: the guilds offered
// have to be the person's own, each with the server it lives on, and a code that was just
// made has to be shown in full, because the whole point of pressing the button is to have
// something to send somebody.
//
//   npm run test:guild-codes

import assert from 'node:assert/strict';

import { normalizeEsoAccountName } from './lib/accountNames.js';
import {
  formatGuildCode,
  isGuildCode,
  makeGuildCode,
  newGuildCode,
  normalizeGuildCode,
} from './lib/guildCodes.js';
import { findOwnGuild, getViewerGuilds, revokeGuildCode } from './lib/store.js';
import { renderGuildCodesPage, renderJoinGuildPage } from './lib/views.js';

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

/** How many times `needle` appears in `text`. */
function count(text, needle) {
  return text.split(needle).length - 1;
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CONFUSING = ['I', 'L', 'O', '0', '1'];

const user = {
  username: 'Ada',
  provider: 'discord',
  providerLabel: 'Discord',
  avatarUrl: '',
};

const guilds = [
  { guild_id: 1001, guild_name: 'Alphabet Mafia', platform: 2, world_name: 'NA Megaserver' },
  { guild_id: 2002, guild_name: 'Ghosts <of> the Reach', platform: 2, world_name: 'EU Megaserver' },
];

const codes = [
  {
    code: 'K7QM3XPD',
    guildName: 'Alphabet Mafia',
    platform: 2,
    worldName: 'NA Megaserver',
    redemptions: 2,
  },
  {
    code: 'ABCD2345',
    guildName: 'Ghosts <of> the Reach',
    platform: 2,
    worldName: 'EU Megaserver',
    redemptions: 0,
  },
];

// ------------------------------------------------------------------ the format

await t('a code is eight characters from the alphabet that survives being read aloud', () => {
  for (let turn = 0; turn < 200; turn += 1) {
    const code = newGuildCode();

    assert.equal(code.length, 8, `expected eight characters, got ${code}`);
    assert.match(code, /^[A-Z2-9]{8}$/, `unexpected character in ${code}`);

    for (const character of code) {
      assert.ok(ALPHABET.includes(character), `${character} is not in the alphabet`);
    }
  }
});

await t('a code never carries a character that is read as another', () => {
  for (let turn = 0; turn < 500; turn += 1) {
    const code = newGuildCode();

    for (const confusing of CONFUSING) {
      assert.equal(code.includes(confusing), false, `${code} contains ${confusing}`);
    }
  }
});

await t('what was typed is turned into the code it must have meant', () => {
  assert.equal(normalizeGuildCode(' k7qm-3xpd '), 'K7QM3XPD', 'case, spaces and dashes go');
  assert.equal(normalizeGuildCode('k7qm 3xpd!'), 'K7QM3XPD', 'punctuation is not part of it');
  assert.equal(normalizeGuildCode(''), '');
  assert.equal(normalizeGuildCode(null), '');
  assert.equal(normalizeGuildCode('K7QM3XPDEXTRA'), 'K7QM3XPD', 'a pasted tail is dropped');
});

await t('a code is written in two halves', () => {
  assert.equal(formatGuildCode('k7qm3xpd'), 'K7QM-3XPD');
  assert.equal(formatGuildCode('K7QM-3XPD'), 'K7QM-3XPD', 'formatting twice changes nothing');
  assert.equal(formatGuildCode('K7QM'), 'K7QM', 'a part is left as it is rather than guessed at');
});

await t('a code of the wrong length, or one the site would never make, is refused', () => {
  assert.equal(isGuildCode('k7qm-3xpd'), true);
  assert.equal(isGuildCode('K7QM3XP'), false, 'seven characters is not a code');
  // Eight is read off the front: a code pasted with an extra character still works, which
  // is the same forgiveness that drops the dashes. A character typed in the wrong place is
  // a different code and will not be found.
  assert.equal(isGuildCode('K7QM3XPDX'), true, 'a pasted tail is trimmed, not refused');
  assert.equal(isGuildCode('K7QM3XP0'), false, '0 is never in a code');
  assert.equal(isGuildCode('K7QM3XPI'), false, 'nor is I');
  assert.equal(isGuildCode(''), false);
});

await t('the bytes that would make some characters likelier are skipped', () => {
  // 248 is the first byte that does not divide evenly into thirty-one characters.
  const made = makeGuildCode(Uint8Array.from([248, 249, 250, 0, 1, 2, 3, 4, 5, 6, 7]));

  assert.equal(made, 'ABCDEFGH', `expected the biased bytes to be skipped, got ${made}`);
});

// --------------------------------------------------------------- the codes page

const codesPage = renderGuildCodesPage({ guilds, codes, user });

await t('the codes page offers the person’s own guilds, each with its server', () => {
  assert.match(codesPage, /method="post" action="\/guilds\/codes"/);
  assert.match(codesPage, /<select name="guild" required>/);
  assert.match(codesPage, /Alphabet Mafia/);
  assert.match(codesPage, /NA Megaserver/, 'the world is what tells two guilds apart');
  assert.match(codesPage, /EU Megaserver/);
  assert.match(codesPage, /Create code/);
  assert.equal(count(codesPage, '<option value='), 2, 'one choice per guild, and no others');
});

await t('each choice carries the guild, its platform and its world', () => {
  const values = [...codesPage.matchAll(/<option value="([^"]+)"/g)].map((hit) =>
    hit[1].split('|').map((part) => decodeURIComponent(part))
  );

  assert.deepEqual(values, [
    ['1001', '2', 'NA Megaserver'],
    ['2002', '2', 'EU Megaserver'],
  ]);
});

await t('a guild name is escaped, wherever it is printed', () => {
  assert.equal(codesPage.includes('<of>'), false, 'the raw name must not reach the page');
  assert.match(codesPage, /Ghosts &lt;of&gt; the Reach/);
});

await t('a code that was just made is shown in full, above everything else', () => {
  const justMade = renderGuildCodesPage({ guilds, codes: [], made: 'k7qm3xpd', user });

  assert.match(justMade, /K7QM-3XPD/, 'the code is what somebody needs to copy');
  assert.match(justMade, /Share this code/);
  assert.ok(
    justMade.indexOf('Share this code') < justMade.indexOf('<h2>Create Guild Code</h2>'),
    'the new code comes before the form that makes another'
  );
});

await t('codes already made are listed with how many people used them', () => {
  assert.match(codesPage, /K7QM-3XPD/);
  assert.match(codesPage, /2 people have joined/);
  assert.match(codesPage, /nobody has joined yet/);
  assert.match(codesPage, /Codes you have made/);
});

await t('a page with no guilds says what to do first', () => {
  const none = renderGuildCodesPage({ guilds: [], codes: [], user });

  assert.match(none, /No guilds to invite from/);
  assert.match(none, /saved variables file/i);
  assert.match(none, /not one you can hand on/, 'the extra slot is named as not grantable');
  assert.equal(
    count(none, 'action="/guilds/codes"'),
    0,
    'a form that could only fail is not drawn at all'
  );
});

// ---------------------------------------------------------------- the join page

const joinPage = renderJoinGuildPage({ user });

await t('the join page is one box, and it posts the code', () => {
  assert.match(joinPage, /method="post" action="\/guilds\/join"/);
  assert.match(joinPage, /<input id="guild-code" name="code"/);
  assert.match(joinPage, /Use Guild Code/);
  assert.equal(count(joinPage, 'type="password"'), 0, 'nothing here is a password');
  assert.doesNotMatch(joinPage, /src="\/app\.js"/, 'there is no item list to script');
});

await t('a refused code keeps what was typed and says why', () => {
  const refused = renderJoinGuildPage({
    notice: 'That code is not one this site made.',
    code: 'k7qm-3xpd',
    user,
  });

  assert.match(refused, /value="K7QM3XPD"/, 'the box keeps what was typed');
  assert.match(refused, /<p class="status err">That code is not one this site made\.<\/p>/);
});

// ------------------------------------------------------------------- the way in

await t('both ways to bring somebody in are in the avatar menu', () => {
  assert.match(codesPage, /<a class="account-menu-item" href="\/guilds\/codes" role="menuitem">/);
  assert.match(codesPage, /<a class="account-menu-item" href="\/guilds\/join" role="menuitem">/);
  assert.match(codesPage, /Create Guild Code/);
  assert.match(codesPage, /Use Guild Code/);
});

// ------------------------------------------------------- the used code, in reach

await t('the code box is on the screen when signed in, not only in the menu', () => {
  assert.match(
    joinPage,
    /<a class="code-link" href="\/guilds\/join">Use Guild Code<\/a>/,
    'the person who was just given a code should not have to find the menu first'
  );
  assert.match(joinPage, /<div class="auth-area">/);

  const signedOut = renderJoinGuildPage({});

  assert.doesNotMatch(
    signedOut,
    /class="code-link"/,
    'a code needs an account to open on, so there is nothing to offer before signing in'
  );
});

// -------------------------------------------------------- whose account is it

await t('a code with no account on file asks for the account, over the page', () => {
  const asks = renderJoinGuildPage({ needAccount: true, code: 'k7qm-3xpd', user });

  assert.match(asks, /role="dialog" aria-modal="true"/, 'it is a box over the page');
  assert.match(asks, /Which ESO account is yours\?/);
  assert.match(
    asks,
    /<input type="hidden" name="code" value="K7QM3XPD">/,
    'the code is carried into the answer, so it does not have to be typed again'
  );
  assert.match(asks, /name="accountName"/);
  assert.match(asks, /<select name="platform" required>/);
  assert.match(asks, /<select name="worldName" required>/);
  assert.match(asks, /Use this code/);
  assert.match(asks, /the site adds the @ if you leave it out/);
  assert.match(asks, /method="post" action="\/guilds\/join"/);

  assert.doesNotMatch(
    joinPage,
    /name="accountName"/,
    'the box is not drawn when the site already knows an account'
  );
});

await t('an account name typed without the @ is given one', () => {
  assert.equal(normalizeEsoAccountName('Some One'), '@someone');
  assert.equal(normalizeEsoAccountName('@SomeOne'), '@someone');
  assert.equal(normalizeEsoAccountName('  '), '', 'nothing usable is not a name');
});

// ------------------------------------------------------------- getting back out

await t('every page has a way back to the item list, and the codes page is no exception', () => {
  assert.match(codesPage, /<a class="brand" href="\/" aria-label="ItemShare home">/);
  assert.match(codesPage, /<p class="guild-back"><a class="primary-button" href="\/">Back to ItemShare<\/a><\/p>/);
  assert.match(joinPage, /<p class="guild-back"><a class="primary-button" href="\/">Back to ItemShare<\/a><\/p>/);
});

await t('the avatar menu works on the pages that have no item list', () => {
  assert.match(codesPage, /src="\/header-menu\.js"/, 'the menu is opened by its own script');
  assert.match(joinPage, /src="\/header-menu\.js"/);
  assert.doesNotMatch(joinPage, /src="\/app\.js"/, 'the item list is still not loaded');
});

// ----------------------------------------------------------------- revoking one

await t('every code can be revoked from the list of codes', () => {
  assert.equal(count(codesPage, 'action="/guilds/codes/revoke"'), 2, 'one button per code');
  assert.match(codesPage, /<input type="hidden" name="code" value="K7QM-3XPD">/);
  assert.match(codesPage, /<input type="hidden" name="code" value="ABCD-2345">/);
  assert.match(codesPage, />Revoke</);
  assert.match(codesPage, /takes back the guild access it gave/i, 'the page says what it does');
});

await t('a revoked code is reported where the codes are', () => {
  const revoked = renderGuildCodesPage({
    guilds,
    codes: [],
    done: 'The code for Alphabet Mafia is gone. The one membership it gave was taken back.',
    user,
  });

  assert.match(revoked, /<p class="status ok">The code for Alphabet Mafia is gone\./);
  assert.match(revoked, /You have not made a code yet/, 'and it is no longer listed');
});

// -------------------------------------------------------------- revoking, in SQL

/** A connection that records what it was asked and answers with the given code. */
function writtenDown({ code = null, affectedRows = 0 } = {}) {
  const calls = [];

  return {
    calls,
    async execute(sql, params = []) {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: flat, params });

      return flat.startsWith('SELECT id, code, guild_name')
        ? [code ? [code] : []]
        : [{ affectedRows }];
    },
  };
}

await t('revoking deletes the code, who used it, and only the rows it granted', async () => {
  const connection = writtenDown({
    code: {
      id: 7,
      code: 'K7QM3XPD',
      guild_name: 'Alphabet Mafia',
      platform: 2,
      world_name: 'NA Megaserver',
    },
    affectedRows: 2,
  });

  const outcome = await revokeGuildCode(connection, { userId: 3, code: 'k7qm-3xpd' });

  assert.equal(outcome.status, 'revoked');
  assert.equal(outcome.accounts, 2, 'two memberships were taken back');
  assert.deepEqual(connection.calls[0].params, ['K7QM3XPD', 3], 'the code has to be theirs');

  const deletes = connection.calls.filter((call) => call.sql.startsWith('DELETE'));

  assert.equal(deletes.length, 3, 'grants, then redemptions, then the code itself');
  assert.match(deletes[0].sql, /DELETE FROM itemshare_account_guilds WHERE granted_code_id = \?/);
  assert.deepEqual(deletes[0].params, [7], 'only the rows this code wrote');
  assert.match(deletes[1].sql, /FROM itemshare_guild_code_redemptions WHERE code_id = \?/);
  assert.match(deletes[2].sql, /FROM itemshare_guild_codes WHERE id = \?/);
  assert.deepEqual(deletes[2].params, [7]);
});

await t('a code made by somebody else is not revoked by knowing it', async () => {
  const connection = writtenDown();

  const outcome = await revokeGuildCode(connection, { userId: 3, code: 'K7QM3XPD' });

  assert.equal(outcome.status, 'unknown');
  assert.equal(
    connection.calls.filter((call) => call.sql.startsWith('DELETE')).length,
    0,
    'nothing is deleted when the code is not theirs'
  );
});

// ----------------------------------------------------- who may invite, and from what

await t('only the guilds the game reported can be made into codes', async () => {
  const connection = writtenDown();

  await getViewerGuilds(connection, ['@ada'], { grantableOnly: true });

  assert.match(
    connection.calls[0].sql,
    /ag\.granted_code_id IS NULL/,
    'a guild a code opened is not offered'
  );
});

await t('the guild list the site browses by still shows a guild a code opened', async () => {
  const connection = writtenDown();

  await getViewerGuilds(connection, ['@ada']);

  assert.doesNotMatch(
    connection.calls[0].sql,
    /granted_code_id IS NULL/,
    'the ordinary list is not narrowed'
  );
  assert.match(connection.calls[0].sql, /granted_code_id IS NOT NULL/, 'and it is still visible');
});

await t('a guild a code opened cannot be made into a code of its own', async () => {
  const connection = writtenDown();

  await findOwnGuild(connection, 3, { guildId: 1001, platform: 2, worldName: 'NA Megaserver' });

  assert.match(
    connection.calls[0].sql,
    /ag\.granted_code_id IS NULL/,
    'a hand-written form cannot reach the extra slot either'
  );
  assert.deepEqual(connection.calls[0].params, [3, 1001, 2, 'NA Megaserver']);
});

await t('the way back is a button, not a line of text', () => {
  const button = /<p class="guild-back"><a class="primary-button" href="\/">Back to ItemShare<\/a><\/p>/;

  assert.match(codesPage, button);
  assert.match(joinPage, button);
});

await t('the joining page says what revoking does to the slot it gave', () => {
  assert.match(joinPage, /the extra slot goes with it/, 'the note warns that revocation is real');
  assert.match(codesPage, /Only you can see the codes you have made/, 'and who can see the list');
});

// ----------------------------------------------------------- where the code points

await t('a code says which platform and server it belongs to, not just the guild', () => {
  const rows = [...codesPage.matchAll(/<span class="code-guild">([^<]*)<\/span>/g)].map(
    (hit) => hit[1]
  );

  assert.deepEqual(rows, [
    'Alphabet Mafia &middot; PC \u00b7 NA Megaserver',
    'Ghosts &lt;of&gt; the Reach &middot; PC \u00b7 EU Megaserver',
  ]);
});

await t('the guild choices carry the platform too', () => {
  assert.match(codesPage, />Alphabet Mafia &middot; PC \u00b7 NA Megaserver<\/option>/);
});

await t('a platform the site does not name is shown as its number, not guessed at', () => {
  const other = renderGuildCodesPage({
    guilds: [],
    codes: [
      {
        code: 'WXYZ2345',
        guildName: 'Console Guild',
        platform: 1,
        worldName: 'NA Megaserver',
        redemptions: 0,
      },
    ],
    user,
  });

  assert.match(other, /Console Guild &middot; platform 1 \u00b7 NA Megaserver/);
});

console.log(`\n${total - failures}/${total} passed`);

if (failures > 0) {
  process.exitCode = 1;
}
