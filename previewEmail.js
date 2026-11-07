#!/usr/bin/env node
// Writes a request email to a file, so the message can be looked at without sending it.
//
//   npm run email:preview                -> email-preview.html and email-preview.txt
//   npm run email:preview -- out.html    -> out.html and out.txt
//
// It renders through the site's own renderRequestEmail, with the same two sample items
// the mail test uses, so what the file shows is what an owner receives: the quality
// colours, the detail lines and the answer link. Nothing is sent, no mail transport is
// needed and no database is opened, so a change to the message can be checked on a
// machine that cannot send mail at all.

import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { emailConfig, renderRequestEmail } from './lib/email.js';

const requested = String(process.argv[2] || '').trim();
const htmlPath = resolve(requested || 'email-preview.html');
const textPath = `${htmlPath.replace(/\.html?$/i, '')}.txt`;

const config = emailConfig();

// A preview with no link would hide the half of the message that matters, so an unset
// BASE_URL falls back to a placeholder origin - said out loud below - rather than quietly
// rendering the plain-list variant a host with no public address sends.
const usingPlaceholder = !config.siteUrl;
const siteUrl = config.siteUrl || 'https://itemshare.example';

// A real message carries a token issued for its own rows. This one is a sample, so the
// link opens the answer page but records nothing.
const sampleToken = '0'.repeat(64);
const answerUrl = `${siteUrl}/requests/fulfill/${sampleToken}`;

const message = renderRequestEmail({
  requester: 'Test Requester',
  requesterAccount: '@TestRequester',
  ownerAccount: '@TestOwner',
  items: [
    {
      id: 1,
      name: 'Briarheart Dagger',
      type: 'Weapon',
      trait: 'Sharpened',
      enchant: '',
      location: 'House Storage 1',
      quality: 4,
      quantity: 2,
    },
    {
      id: 2,
      name: 'Soul Gem',
      type: 'Miscellaneous',
      trait: '',
      enchant: '',
      location: 'Bank',
      quality: 1,
      quantity: 5,
    },
  ],
  siteUrl,
  answerUrl,
});

writeFileSync(htmlPath, message.html, 'utf8');
writeFileSync(textPath, message.text, 'utf8');

console.log(`Subject: ${message.subject}`);
console.log(`HTML:    ${htmlPath}`);
console.log(`Text:    ${textPath}`);

console.log(`Link:    ${answerUrl}`);
console.log('         (a sample token: the page opens, and records nothing)');

if (usingPlaceholder) {
  console.log(
    'Origin:  BASE_URL is not set, so itemshare.example stands in. Set BASE_URL in .env to see the address an owner would get.'
  );
}

console.log('Nothing was sent. Open the HTML file in a browser to see what an owner gets.');
