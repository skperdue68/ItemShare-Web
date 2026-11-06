// The way back in for somebody who has forgotten a password.
//
// Kept apart from email.js because it shares none of that layout: this message is one
// link, how long it lasts, and what to do if it was not you. Every word that is not the
// link is a reason not to click it, so there are very few.

function escape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {object} options
 * @param {string} options.resetUrl the link that opens the form
 * @param {string} [options.siteUrl] the site, for the footer and the plain-text copy
 * @param {number} [options.expiresMinutes] how long the link lives
 * @param {string} [options.displayName] the name to greet, if there is one
 * @returns {{subject: string, text: string, html: string}}
 */
export function renderPasswordResetEmail({
  resetUrl = '',
  siteUrl = '',
  expiresMinutes = 30,
  displayName = '',
} = {}) {
  const link = String(resetUrl || '').trim();
  const minutes = Math.max(1, Math.round(Number(expiresMinutes) || 30));
  const hello = displayName ? `Hello ${displayName},` : 'Hello,';

  const text = [
    hello,
    '',
    'Somebody asked to reset the password for this email address on ItemShare.',
    '',
    link ? `Choose a new password: ${link}` : 'Ask for a new link from the sign-in page.',
    '',
    `The link works once and expires in ${minutes} minutes.`,
    '',
    'If this was not you, ignore this message: your password has not changed.',
    siteUrl ? `\nItemShare: ${siteUrl}` : '',
  ]
    .join('\n')
    .trim();

  const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:24px;background:#f4f6fa;font-family:Arial,Helvetica,sans-serif;color:#1f2733;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;">
    <tr>
      <td style="padding:24px;">
        <p style="margin:0 0 12px;font-size:15px;">${escape(hello)}</p>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">
          Somebody asked to reset the password for this email address on ItemShare.
        </p>
        ${
          link
            ? `<p style="margin:0 0 20px;">
          <a href="${escape(link)}" style="display:inline-block;padding:12px 20px;background:#2f6fed;color:#ffffff;text-decoration:none;border-radius:6px;font-size:15px;">Choose a new password</a>
        </p>
        <p style="margin:0 0 12px;font-size:13px;color:#4a5568;word-break:break-all;">
          If the button does not work, open this address: ${escape(link)}
        </p>`
            : `<p style="margin:0 0 16px;font-size:15px;">Ask for a new link from the sign-in page.</p>`
        }
        <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">
          The link works once and expires in ${minutes} minutes.
        </p>
        <p style="margin:0;font-size:13px;color:#4a5568;line-height:1.5;">
          If this was not you, ignore this message: your password has not changed.
        </p>
      </td>
    </tr>
    ${
      siteUrl
        ? `<tr><td style="padding:0 24px 24px;font-size:12px;color:#8a94a6;">${escape(siteUrl)}</td></tr>`
        : ''
    }
  </table>
</body>
</html>`;

  return { subject: 'Reset your ItemShare password', text, html };
}
