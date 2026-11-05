// Request emails.
//
// The site sends these through Resend's HTTP API (`POST /emails`), so nothing has to
// be installed and the key stays in .env:
//
//   RESEND_API_KEY=re_...
//   EMAIL_FROM=ItemShare <requests@your-domain.example>
//
// Two optional settings exist to test mail without mailing anybody: EMAIL_OVERRIDE_TO
// sends every message to one address (with a notice saying who it was for), and
// EMAIL_TRANSPORT=none sends nothing at all once the mail is known to work.
//
// With either missing the site still works and requests still send - the server log
// says the email was skipped, which is an honest state rather than a silent failure.
//
// The message is built here rather than in views.js because email clients are not
// browsers: the layout is a table with inline styles, and there is a plain-text copy
// for clients that refuse HTML.

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const ENDPOINT = 'https://api.resend.com/emails';

// Quality colours that survive a white mail body: the game's own white would vanish
// there, so the ordinary tier is a dark grey instead.
const QUALITY_COLOURS = {
  1: '#4a4a4a',
  2: '#2e8b3a',
  3: '#2f6fed',
  4: '#7a3fd1',
  5: '#a87400',
};

function qualityColour(quality) {
  return QUALITY_COLOURS[Number(quality) || 0] || '#3c4557';
}

/**
 * What tells two copies of the same name apart: its type, its trait and, when it has
 * one, its enchantment. Two Briarheart swords with different traits are the same
 * name, so this is the line the owner actually needs to pick the right one.
 */
function itemDetailText(item) {
  return [item.type, item.trait, item.enchant ? `Enchant: ${item.enchant}` : '']
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' \u00b7 ');
}

function escape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Where mail leaves the machine. On a Linux host that already runs a mail server,
// the standard `sendmail` interface is enough: no account, no key and no HTTP
// service in the middle. Resend stays available for hosts without one (Windows
// during development, for example). EMAIL_TRANSPORT forces a choice, or none.
const SENDMAIL_CANDIDATES = ['/usr/sbin/sendmail', '/usr/lib/sendmail', '/usr/bin/sendmail'];
// Deliberately loose: enough to catch a name, a missing @ or a missing domain, which are
// the mistakes that would otherwise send mail to an address nobody reads.
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function findSendmail(env) {
  const configured = String(env.SENDMAIL_PATH || '').trim();

  if (configured) {
    return existsSync(configured) ? configured : '';
  }

  return SENDMAIL_CANDIDATES.find((path) => existsSync(path)) || '';
}

export function emailConfig(env = process.env) {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  const from = String(env.EMAIL_FROM || '').trim();
  const siteUrl = String(env.BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  const sendmail = findSendmail(env);
  const wanted = String(env.EMAIL_TRANSPORT || '').trim().toLowerCase();
  // Every message can be pointed at one address while the site is still being tested, so
  // a real guildmate never receives test mail. The message itself does not change: the
  // notice naming the real recipient goes inside it.
  const overrideTo = String(env.EMAIL_OVERRIDE_TO || '').trim();
  const overrideProblem =
    overrideTo && !EMAIL_ADDRESS.test(overrideTo)
      ? 'EMAIL_OVERRIDE_TO does not look like an email address, so nothing is sent rather than mail going to real owners'
      : '';

  let provider = '';

  if (wanted === 'sendmail') {
    provider = sendmail && from ? 'sendmail' : '';
  } else if (wanted === 'resend') {
    provider = apiKey && from ? 'resend' : '';
  } else if (wanted !== 'none') {
    // Default: the host's own mail server when there is one, otherwise Resend.
    provider = sendmail && from ? 'sendmail' : apiKey && from ? 'resend' : '';
  }

  const reason = !from
    ? 'set EMAIL_FROM in .env to the address mail should come from'
    : overrideProblem
      ? overrideProblem
      : provider
        ? ''
        : wanted === 'none'
          ? 'mail is turned off with EMAIL_TRANSPORT=none'
          : `no mail transport - ${
              process.platform === 'win32'
                ? 'Windows has no sendmail, so set RESEND_API_KEY'
                : 'no sendmail was found on this host'
            }`;

  return {
    apiKey,
    from,
    siteUrl,
    sendmail,
    overrideTo,
    provider,
    reason,
    configured: Boolean(provider) && !overrideProblem,
  };
}

/**
 * One request email: what was asked for, how many of each, and the ESO name to mail
 * it to. `items` is a plain list, because the caller has already grouped the requests
 * by the person who owns them.
 */
export function renderRequestEmail({
  requester = '',
  requesterAccount = '',
  ownerAccount = '',
  items = [],
  siteUrl = '',
  // Where the form posts to when this message carries one. Blank means the message is
  // a plain list, which is what the mail test sends and what a site without BASE_URL
  // can offer.
  formUrl = '',
  sentAt = new Date(),
}) {
  const who = requesterAccount || requester || 'Someone';
  const total = items.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
  const subject = `ESO Item Request from ${who}${items.length > 1 ? ` (${items.length} items)` : ''}`;
  const when = sentAt instanceof Date ? sentAt.toUTCString() : String(sentAt);
  const askedFor = (item) => Math.max(1, Number(item.quantity) || 1);

  // One form per row, not one for the message. An owner rarely mails a whole message at
  // once: they send what they have, come back for the rest, or answer one and leave the
  // others alone. A single Done for every row made a partial answer look like a
  // decision about all of them, and it could only be sent once.
  const rows = items
    .map((item) => {
      const details = itemDetailText(item);
      const ask = askedFor(item);

      return `
              <tr>
                <td style="padding:8px 0;border-bottom:1px solid #e7e9ef;font-size:14px">
                  <span style="color:${qualityColour(
                    item.quality
                  )};font-weight:600">${escape(item.name)}</span>${
                    details
                      ? `<div style="margin-top:2px;font-size:12px;color:#6b7280">${escape(
                          details
                        )}</div>`
                      : ''
                  }
                </td>
                <td style="padding:8px 0;border-bottom:1px solid #e7e9ef;font-size:14px;text-align:right;font-variant-numeric:tabular-nums;vertical-align:top">${
                  formUrl
                    ? `<form method="post" action="${escape(
                        formUrl
                      )}" style="margin:0;white-space:nowrap">
                  <input type="hidden" name="row" value="${Number(item.id) || 0}">
                  <input type="number" name="quantity" value="${ask}" min="0" max="${ask}" step="1" inputmode="numeric" aria-label="How many ${escape(
                    item.name
                  )} you sent" style="width:52px;padding:6px 8px;border:1px solid #c7cddb;border-radius:6px;font-size:14px;text-align:right;font-variant-numeric:tabular-nums;color:#1f2430;background:#ffffff">
                  <button type="submit" style="margin-left:6px;padding:7px 12px;border:0;border-radius:6px;background:#2f6fed;color:#ffffff;font-size:12.5px;font-weight:700;cursor:pointer">Save</button>
                  </form>`
                    : ask
                }</td>
              </tr>`;
    })
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:#f4f5f7;color:#1f2430;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;border:1px solid #e3e6ee">
          <tr>
            <td style="padding:16px 22px;background:#1b2440;border-radius:10px 10px 0 0;color:#eef2ff;font-size:12px;letter-spacing:.12em;text-transform:uppercase">
              ESO Item Request
            </td>
          </tr>
          <tr>
            <td style="padding:22px">
              <h1 style="margin:0 0 10px;font-size:19px;line-height:1.3">${escape(
                who
              )} asked you for ${items.length === 1 ? 'an item' : `${items.length} items`}</h1>
              <p style="margin:0 0 18px;font-size:14px;line-height:1.55;color:#3c4557">
                These are shared from <strong>${escape(
                  ownerAccount
                )}</strong> on ItemShare, and someone has asked for them. Mail ${
                  total === 1 ? 'it' : 'them'
                } to <strong>${escape(who)}</strong> in game, then say what you actually
                sent below.
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px">
                <tr>
                  <th align="left" style="padding:0 0 6px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#7a8395">Item</th>
                  <th align="right" style="padding:0 0 6px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#7a8395">Qty</th>
                </tr>${rows}
              </table>
              ${
                formUrl
                  ? `<p style="margin:16px 0 0;font-size:12.5px;line-height:1.55;color:#5b6478">
                Set the number on a row to what you actually mailed and press <strong>Save</strong>
                on that row - each row is recorded on its own, so you can do the ones you have
                sent now and the rest when you get to them. <strong>0</strong> means you sent
                nothing from that row, and it cancels that request.
              </p>
              <p style="margin:12px 0 0;font-size:12px;color:#8a92a3">
                Some mail apps do not allow forms. If a Save button does nothing,
                <a href="${escape(formUrl)}" style="color:#2f6fed">open the form on ItemShare</a>.
              </p>`
                  : ''
              }
              <p style="margin:18px 0 0;font-size:13px;color:#5b6478">
                Sent from ItemShare on ${escape(when)}.${
                  siteUrl
                    ? ` <a href="${escape(siteUrl)}/" style="color:#2f6fed">Open your list</a> to cancel or change what you share.`
                    : ''
                }
              </p>
            </td>
          </tr>
        </table>
        <p style="margin:14px 0 0;font-size:12px;color:#8a92a3">
          You are getting this because your ESO account ${escape(
            ownerAccount
          )} shares these items on ItemShare.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    'ESO Item Request',
    '',
    `${who} asked you for these items from ${ownerAccount} on ItemShare:`,
    '',
    ...items.map((item) => {
      const details = itemDetailText(item);
      return `  ${Number(item.quantity) || 1} x ${item.name}${details ? ` - ${details}` : ''}`;
    }),
    '',
    formUrl
      ? `Mail ${total === 1 ? 'it' : 'them'} to ${who} in game, then say what you actually sent here:`
      : `Mail ${total === 1 ? 'it' : 'them'} to ${who} in game when you are next online.`,
    formUrl,
    formUrl
      ? 'Change the number on each row to what you sent - 0 cancels that row - and press Save on that row. Each row is recorded on its own.'
      : '',
    `Sent ${when}.`,
    siteUrl ? `${siteUrl}/` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return { subject, html, text };
}

function headerSafe(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/**
 * The notice EMAIL_OVERRIDE_TO adds. A redirected message has to stay the real message,
 * because seeing what an owner would get is the whole point of the override, so the only
 * difference is a line saying where it would have gone. It goes inside the body, above
 * everything else, so no client can hide it.
 */
function withTestNotice({ subject, html, text }, intended) {
  const notice = `<div style="margin:0 0 16px;padding:10px 14px;border:1px dashed #b45309;border-radius:8px;background:#fffbeb;color:#92400e;font-size:13px;line-height:1.5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"><strong>Test copy</strong> &mdash; in production this message goes to <strong>${escape(
    intended
  )}</strong>.</div>`;

  return {
    subject: `[Test: ${intended}] ${subject}`,
    html: /<body[^>]*>/i.test(html)
      ? html.replace(/<body[^>]*>/i, (tag) => `${tag}${notice}`)
      : `${notice}${html}`,
    text: `[Test copy - in production this message goes to ${intended}]\n\n${text || ''}`,
  };
}

/**
 * The message a mail server expects on stdin: headers, then the plain-text part and
 * the HTML part as alternatives, so each client shows whichever it can.
 */
export function buildMimeMessage({ to, from, subject, html, text, date = new Date() }) {
  const boundary = `itemshare-${date.getTime().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

  return [
    `From: ${headerSafe(from)}`,
    `To: ${headerSafe(to)}`,
    `Subject: ${headerSafe(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${date.getTime()}.${Math.random().toString(36).slice(2, 10)}@itemshare.local>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    text || '',
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    html || '',
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/**
 * Hands the message to the host's mail server through `sendmail -t`, which reads the
 * recipients from the headers. Never throws: a broken or missing MTA has to leave the
 * request itself untouched, exactly like a failing HTTP provider would.
 */
function sendWithSendmail({ to, subject, html, text }, config) {
  return new Promise((resolve) => {
    const message = buildMimeMessage({ to, from: config.from, subject, html, text });
    let finished = false;
    const finish = (result) => {
      if (!finished) {
        finished = true;
        resolve(result);
      }
    };

    let child;

    try {
      child = spawn(config.sendmail, ['-t', '-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (error) {
      finish({ ok: false, error: error.message });
      return;
    }

    let stderr = '';
    const killer = setTimeout(() => child.kill('SIGKILL'), 15000);
    const guard = setTimeout(
      () => finish({ ok: false, error: 'sendmail did not finish in time' }),
      20000
    );

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(killer);
      clearTimeout(guard);
      finish({ ok: false, error: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      clearTimeout(guard);
      finish(
        code === 0
          ? { ok: true, id: 'sendmail' }
          : {
              ok: false,
              error: `sendmail exited ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`,
            }
      );
    });

    // A mail server that exits before reading everything closes the pipe; that is
    // its answer, not a crash on this side.
    child.stdin.on('error', () => {});
    child.stdin.end(message);
  });
}

async function sendWithResend({ to, subject, html, text }, config) {
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: config.from, to: [to], subject, html, text }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return { ok: false, error: `${response.status} ${detail.slice(0, 200)}`.trim() };
    }

    const result = await response.json().catch(() => ({}));
    return { ok: true, id: result.id || '' };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Sends one message through whichever transport is configured. Returns `{ ok }` or
 * `{ ok: false, error }` rather than throwing: mail having a bad day must never turn
 * a sent request into an error page.
 */
export async function sendEmail({ to, subject, html, text }, config = emailConfig()) {
  if (!config.configured) {
    return { ok: false, error: config.reason || 'email is not configured' };
  }

  if (!to) {
    return { ok: false, error: 'no address to send to' };
  }

  // EMAIL_OVERRIDE_TO changes the envelope, never the message: the test copy says on its
  // face who would have received it. EMAIL_TRANSPORT=none is the other side of the same
  // idea - a switched-off site records requests and sends no mail at all.
  const overrideTo = String(config.overrideTo || '').trim();
  const delivered = overrideTo || to;
  const message = overrideTo ? withTestNotice({ subject, html, text }, to) : { subject, html, text };

  const result =
    config.provider === 'sendmail'
      ? await sendWithSendmail({ to: delivered, ...message }, config)
      : await sendWithResend({ to: delivered, ...message }, config);

  return overrideTo ? { ...result, to: delivered, intended: to } : { ...result, to: delivered };
}
