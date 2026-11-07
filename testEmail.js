#!/usr/bin/env node
// Sends one request email through whatever .env configures, so a mail
// setup can be checked without waiting for somebody to ask for an item.
//
//   node testEmail.js you@example.com        (npm run email:test -- you@example.com)
//
// This is the site's own path end to end: same configuration, same rendered
// message, same transport. No database connection is opened and nothing is
// written, so a failure here is a mail problem and not an ItemShare one.

import 'dotenv/config';

import { emailConfig, renderRequestEmail, renderStatusEmail, sendEmail } from './lib/email.js';

const to = String(process.argv[2] || '').trim();

// Which message to send: the request an owner answers, or the answer the asker reads.
// `answer` shows both outcomes in one message, which is the mixed case.
const mode = String(process.argv[3] || 'request').trim().toLowerCase();
const MODES = ['request', 'fulfilled', 'cancelled', 'answer'];

if (!to.includes('@') || !MODES.includes(mode)) {
  console.error('Usage: npm run email:test -- you@example.com [request|fulfilled|cancelled|answer]');
  process.exit(2);
}

const config = emailConfig();

if (!config.configured) {
  console.error(`Email is not configured: ${config.reason}.`);
  console.error(
    'Set EMAIL_FROM in .env, and either a sendmail binary on this host or RESEND_API_KEY.'
  );
  process.exit(1);
}

// Two pretend items, so the message has a real list, a quality colour each and the
// detail line an owner would use to tell two copies of a name apart.
const sampleToken = '0'.repeat(64);

// A partial handover next to a refused one, so the answer message shows both outcomes
// and the per-row wording that tells them apart.
const sampleAnswerRows = [
  { id: 1, itemName: 'Briarheart Dagger', type: 'Weapon', trait: 'Sharpened', enchant: '', quality: 4, sent: 2, asked: 3, status: 'fulfilled', ownerAccount: '@TestOwner' },
  { id: 2, itemName: 'Soul Gem', type: 'Miscellaneous', trait: '', enchant: '', quality: 1, sent: 0, asked: 5, status: 'cancelled', ownerAccount: '@TestOwner' },
];

const message =
  mode === 'request'
    ? renderRequestEmail({
        requester: 'Test Requester',
        requesterAccount: '@TestRequester',
        ownerAccount: '@TestOwner',
        items: [
          { id: 1, name: 'Briarheart Dagger', type: 'Weapon', trait: 'Sharpened', enchant: '', quality: 4, quantity: 2, location: 'House Storage 1' },
          { id: 2, name: 'Soul Gem', type: 'Miscellaneous', trait: '', enchant: '', quality: 1, quantity: 5, location: 'Bank' },
        ],
        siteUrl: config.siteUrl,
        // Real messages carry a token issued for their own rows; this one is a sample, so
        // the link is here to look at but opens a page that records nothing.
        answerUrl: config.siteUrl ? `${config.siteUrl}/requests/fulfill/${sampleToken}` : '',
      })
    : renderStatusEmail({
        requesterName: 'Test Requester',
        rows:
          mode === 'fulfilled'
            ? sampleAnswerRows.map((row) => ({ ...row, status: 'fulfilled', sent: row.asked }))
            : mode === 'cancelled'
              ? sampleAnswerRows.map((row) => ({ ...row, status: 'cancelled', sent: 0 }))
              : sampleAnswerRows,
        siteUrl: config.siteUrl,
      });

if (mode === 'request' && message.html.includes(sampleToken)) {
  console.log('The Answer button uses a sample link: it opens the page, but records nothing.');
}

console.log(
  `Transport: ${config.provider}${config.provider === 'sendmail' ? ` (${config.sendmail})` : ''}`
);
console.log(`From:      ${config.from}`);
console.log(`To:        ${to}`);

// Worth saying out loud: a test address and EMAIL_OVERRIDE_TO can both be set, and then
// the Gmail or Resend dashboard shows the override, not the address typed on the command.
if (config.overrideTo) {
  console.log(`Redirect:  every message goes to ${config.overrideTo} (would have gone to ${to})`);
}
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
