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

import {
  formatGuildCode,
  isGuildCode,
  makeGuildCode,
  newGuildCode,
  normalizeGuildCode,
} from './lib/guildCodes.js';
import { renderGuildCodesPage, renderJoinGuildPage } from './lib/views.js';

let total = 0;
let failures = 0;

function t(name, fn) {
  total += 1;

  try {
    fn();
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

t('a code is eight characters from the alphabet that survives being read aloud', () => {
  for (let turn = 0; turn < 200; turn += 1) {
    const code = newGuildCode();

    assert.equal(code.length, 8, `expected eight characters, got ${code}`);
    assert.match(code, /^[A-Z2-9]{8}$/, `unexpected character in ${code}`);

    for (const character of code) {
      assert.ok(ALPHABET.includes(character), `${character} is not in the alphabet`);
    }
  }
});

t('a code never carries a character that is read as another', () => {
  for (let turn = 0; turn < 500; turn += 1) {
    const code = newGuildCode();

    for (const confusing of CONFUSING) {
      assert.equal(code.includes(confusing), false, `${code} contains ${confusing}`);
    }
  }
});

t('what was typed is turned into the code it must have meant', () => {
  assert.equal(normalizeGuildCode(' k7qm-3xpd '), 'K7QM3XPD', 'case, spaces and dashes go');
  assert.equal(normalizeGuildCode('k7qm 3xpd!'), 'K7QM3XPD', 'punctuation is not part of it');
  assert.equal(normalizeGuildCode(''), '');
  assert.equal(normalizeGuildCode(null), '');
  assert.equal(normalizeGuildCode('K7QM3XPDEXTRA'), 'K7QM3XPD', 'a pasted tail is dropped');
});

t('a code is written in two halves', () => {
  assert.equal(formatGuildCode('k7qm3xpd'), 'K7QM-3XPD');
  assert.equal(formatGuildCode('K7QM-3XPD'), 'K7QM-3XPD', 'formatting twice changes nothing');
  assert.equal(formatGuildCode('K7QM'), 'K7QM', 'a part is left as it is rather than guessed at');
});

t('a code of the wrong length, or one the site would never make, is refused', () => {
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

t('the bytes that would make some characters likelier are skipped', () => {
  // 248 is the first byte that does not divide evenly into thirty-one characters.
  const made = makeGuildCode(Uint8Array.from([248, 249, 250, 0, 1, 2, 3, 4, 5, 6, 7]));

  assert.equal(made, 'ABCDEFGH', `expected the biased bytes to be skipped, got ${made}`);
});

// --------------------------------------------------------------- the codes page

const codesPage = renderGuildCodesPage({ guilds, codes, user });

t('the codes page offers the person’s own guilds, each with its server', () => {
  assert.match(codesPage, /method="post" action="\/guilds\/codes"/);
  assert.match(codesPage, /<select name="guild" required>/);
  assert.match(codesPage, /Alphabet Mafia/);
  assert.match(codesPage, /NA Megaserver/, 'the world is what tells two guilds apart');
  assert.match(codesPage, /EU Megaserver/);
  assert.match(codesPage, /Create code/);
  assert.equal(count(codesPage, '<option value='), 2, 'one choice per guild, and no others');
});

t('each choice carries the guild, its platform and its world', () => {
  const values = [...codesPage.matchAll(/<option value="([^"]+)"/g)].map((hit) =>
    hit[1].split('|').map((part) => decodeURIComponent(part))
  );

  assert.deepEqual(values, [
    ['1001', '2', 'NA Megaserver'],
    ['2002', '2', 'EU Megaserver'],
  ]);
});

t('a guild name is escaped, wherever it is printed', () => {
  assert.equal(codesPage.includes('<of>'), false, 'the raw name must not reach the page');
  assert.match(codesPage, /Ghosts &lt;of&gt; the Reach/);
});

t('a code that was just made is shown in full, above everything else', () => {
  const justMade = renderGuildCodesPage({ guilds, codes: [], made: 'k7qm3xpd', user });

  assert.match(justMade, /K7QM-3XPD/, 'the code is what somebody needs to copy');
  assert.match(justMade, /Share this code/);
  assert.ok(
    justMade.indexOf('Share this code') < justMade.indexOf('Invite someone to a guild'),
    'the new code comes before the form that makes another'
  );
});

t('codes already made are listed with how many people used them', () => {
  assert.match(codesPage, /K7QM-3XPD/);
  assert.match(codesPage, /2 people have joined/);
  assert.match(codesPage, /nobody has joined yet/);
  assert.match(codesPage, /Codes you have made/);
});

t('a page with no guilds says what to do first', () => {
  const none = renderGuildCodesPage({ guilds: [], codes: [], user });

  assert.match(none, /No guilds yet/);
  assert.match(none, /upload a saved variables file/i);
  assert.equal(
    count(none, 'action="/guilds/codes"'),
    0,
    'a form that could only fail is not drawn at all'
  );
});

// ---------------------------------------------------------------- the join page

const joinPage = renderJoinGuildPage({ user });

t('the join page is one box, and it posts the code', () => {
  assert.match(joinPage, /method="post" action="\/guilds\/join"/);
  assert.match(joinPage, /<input id="guild-code" name="code"/);
  assert.match(joinPage, /Join guild/);
  assert.equal(count(joinPage, 'type="password"'), 0, 'nothing here is a password');
  assert.doesNotMatch(joinPage, /src="\/app\.js"/, 'there is no item list to script');
});

t('a refused code keeps what was typed and says why', () => {
  const refused = renderJoinGuildPage({
    notice: 'That code is not one this site made.',
    code: 'k7qm-3xpd',
    user,
  });

  assert.match(refused, /value="K7QM3XPD"/, 'the box keeps what was typed');
  assert.match(refused, /<p class="status err">That code is not one this site made\.<\/p>/);
});

// ------------------------------------------------------------------- the way in

t('both ways to bring somebody in are in the avatar menu', () => {
  assert.match(codesPage, /<a class="account-menu-item" href="\/guilds\/codes" role="menuitem">/);
  assert.match(codesPage, /<a class="account-menu-item" href="\/guilds\/join" role="menuitem">/);
  assert.match(codesPage, /Invite people to a guild/);
  assert.match(codesPage, /Join a guild with a code/);
});

console.log(`\n${total - failures}/${total} passed`);

if (failures > 0) {
  process.exitCode = 1;
}
