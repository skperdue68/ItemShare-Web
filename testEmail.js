#!/usr/bin/env node
// Sends one request email through whatever Database/.env configures, so a mail
// setup can be checked without waiting for somebody to ask for an item.
//
//   node testEmail.js you@example.com        (npm run email:test -- you@example.com)
//
// This is the site's own path end to end: same configuration, same rendered
// message, same transport. No database connection is opened and nothing is
// written, so a failure here is a mail problem and not an ItemShare one.

import 'dotenv/config';

import { emailConfig, renderRequestEmail, sendEmail } from './lib/email.js';

const to = String(process.argv[2] || '').trim();

if (!to.includes('@')) {
  console.error('Usage: npm run email:test -- you@example.com');
  process.exit(2);
}

const config = emailConfig();

if (!config.configured) {
  console.error(`Email is not configured: ${config.reason}.`);
  console.error(
    'Set EMAIL_FROM in Database/.env, and either a sendmail binary on this host or RESEND_API_KEY.'
  );
  process.exit(1);
}

// Two pretend items, so the message has a real list, a quality colour each and the
// detail line an owner would use to tell two copies of a name apart.
const message = renderRequestEmail({
  requester: 'Test Requester',
  requesterAccount: '@TestRequester',
  ownerAccount: '@TestOwner',
  items: [
    { name: 'Briarheart Dagger', type: 'Weapon', trait: 'Sharpened', enchant: '', quality: 4, quantity: 2 },
    { name: 'Soul Gem', type: 'Miscellaneous', trait: '', enchant: '', quality: 1, quantity: 5 },
  ],
  siteUrl: config.siteUrl,
});

console.log(
  `Transport: ${config.provider}${config.provider === 'sendmail' ? ` (${config.sendmail})` : ''}`
);
console.log(`From:      ${config.from}`);
console.log(`To:        ${to}`);
console.log(`Subject:   ${message.subject}`);

const result = await sendEmail({ to, ...message }, config);

if (!result.ok) {
  console.error(`Not sent: ${result.error}`);
  process.exit(1);
}

console.log('Handed over. Check the inbox and the spam folder.');
console.log(
  config.provider === 'sendmail'
    ? 'If it does not arrive, the mail server took it and did not deliver: check mailq, /var/log/mail.log or journalctl -u postfix.'
    : 'Resend accepted it; its dashboard shows the delivery.'
);
