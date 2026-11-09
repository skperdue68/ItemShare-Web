// Server rendered pages. Styling lives in public/styles.css and follows the
// GuildSync palette (navy gradient, translucent panels, blue accents).

import { createHash } from 'node:crypto';

import { filterList } from './filters.js';
import { serverChoices, serverLabel } from './serverLabel.js';
import { DEMO_EMAIL } from './demo.js';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ESO quality colours, in the game's own numbering: 0 trash, 1 normal (white), 2 fine
// (green), 3 superior (blue), 4 epic (purple), 5 legendary (gold), 6 mythic (orange).
// The addon writes GetItemQuality straight into the file, so the index has to be the
// game's, not a tidy 0-based list: with normal at 0 an epic item painted gold.
const QUALITY_COLORS = [
  '#9ca3af',
  '#e5e7eb',
  '#7cb342',
  '#3b82f6',
  '#a855f7',
  '#fbbf24',
  '#f97316',
];

function qualityColor(quality) {
  const index = Number(quality);
  return QUALITY_COLORS[Number.isFinite(index) ? Math.max(0, Math.min(6, index)) : 1];
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * When a request was sent, in local time: "5 Nov 2026, 14:32". The year is kept
 * because a history spans seasons, and the minutes because two requests in the same
 * hour are ordinary.
 */
export function dateTimeText(value) {
  const date = parseDate(value);

  if (!date) {
    return '';
  }

  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${date.getDate()} ${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}, ${hours}:${minutes}`;
}

/**
 * Request times are kept in UTC and shown in the reader's own clock.
 *
 * The value that goes into the page is a UTC ISO stamp; app.js rewrites the text
 * with `toLocaleString`, so the reader's time zone (not the server's) decides what
 * they see. The text inside the element is the same moment in UTC, which is what a
 * browser with scripting off, or a reader of the source, gets.
 */
export function utcIsoText(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    return value;
  }

  const date =
    value instanceof Date
      ? value
      : /^\d+$/.test(String(value))
        ? new Date(Number(value) * 1000)
        : new Date(String(value));

  // Milliseconds are noise here: the database column has whole seconds, so every
  // stamp is trimmed to the same shape whether it arrived as text or as a Date.
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The same moment written as UTC, for a browser that does not run the script. */
export function utcText(value) {
  const iso = utcIsoText(value);

  if (!iso) {
    return '';
  }

  const date = new Date(iso);
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');

  return `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${hours}:${minutes} UTC`;
}

/**
 * A moment on the clock of the machine running the site, in its own date order.
 *
 * The page that asks the owner what they sent carries no script - it is a form, not a
 * list - so the browser-side localisation other pages get from `data-local-time` would
 * never run here and a UTC stamp would be read as local time. The server's clock owns
 * this data, so it is the honest one to print, with UTC kept in the tooltip.
 */
function localTimeText(value) {
  const iso = utcIsoText(value);

  if (!iso) {
    return '';
  }

  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function localTimeCell(value, note = '') {
  const iso = utcIsoText(value);

  if (!iso) {
    return '&mdash;';
  }

  const utc = `${iso.replace('T', ' ').replace('Z', '').trim()} UTC`;

  return `<time datetime="${escapeHtml(iso)}" title="Kept in UTC as ${escapeHtml(
    note ? `${utc} - ${note}` : utc
  )}">${escapeHtml(localTimeText(iso))}</time>`;
}

/** When a request was sent: a `<time>` the browser localises, with a UTC fallback. */
function sentTimeCell(request) {
  const iso = utcIsoText(request.submitted_at_iso || request.submitted_at);

  if (!iso) {
    return '&mdash;';
  }

  return `<time datetime="${escapeHtml(iso)}" data-local-time>${escapeHtml(utcText(iso))}</time>`;
}


/**
 * When an item first turned up, as something app.js can keep counting.
 *
 * The element carries the moment, and the text inside it is that moment as UTC - what a
 * browser without script, or a reader of the source, gets. app.js finds these by
 * `data-since` and rewrites the text once a second into an age: "12s", "6d 4h 18m 44s",
 * "1y 4mo 19d 7h 33m 5s". A day alone could not say whether something appeared this
 * morning or late last night, and these lists are read for what is new.
 *
 * The column right-aligns the result, because units appear on the left as an item ages and
 * the seconds should keep to one edge.
 */
export function sharedTimeCell(value, note = '') {
  const iso = utcIsoText(value);

  if (!iso) {
    return '';
  }

  const utc = `${iso.replace('T', ' ').replace('Z', '').trim()} UTC`;

  return `<time datetime="${escapeHtml(iso)}" data-since title="Kept in UTC as ${escapeHtml(
    note ? `${utc} - ${note}` : utc
  )}">${escapeHtml(utcText(iso))}</time>`;
}

function parseDate(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const date =
    value instanceof Date
      ? value
      : /^\d+$/.test(String(value))
        ? new Date(Number(value) * 1000)
        : new Date(String(value));

  return Number.isNaN(date.getTime()) ? null : date;
}

// Two initials, the way an avatar reads at a glance. Discord names are one word
// often enough that the fallback matters more than the fancy case.
function initialsFor(username) {
  const words = String(username || '')
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);

  if (words.length === 0) {
    return '?';
  }

  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }

  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

// Signed in: a circular avatar that opens a small menu, with Log out inside it.
// The logout is a real form post, so it still works with scripts blocked.
function authArea(user, providers, accounts = [], { showSignedOut = true } = {}) {
  if (user) {
    const name = escapeHtml(user.username || 'signed in');
    const provider = escapeHtml(user.providerLabel || user.provider || 'sign-in');
    const initials = escapeHtml(initialsFor(user.username));
    // Nothing can be shown before the first upload, so until an ESO account is linked
    // the menu offers only what is useful: who you signed in as, and the way out.
    const hasAccounts = Array.isArray(accounts) && accounts.length > 0;

    // The picture sits on top of the initials, so if it fails to load the initials are
    // already there. app.js removes a broken image; without scripts the alt text is
    // empty, so nothing worse than a blank circle appears.
    const avatar = user.avatarUrl
      ? `<span class="avatar avatar-with-photo" aria-hidden="true">
            <span class="avatar-initials">${initials}</span>
            <img class="avatar-photo" src="${escapeHtml(user.avatarUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">
          </span>`
      : `<span class="avatar" aria-hidden="true">${initials}</span>`;

    return `
      <div class="account-menu">
        <span class="account-name" title="${name}">${name}</span>
        <button class="avatar-button" type="button" id="accountMenuButton"
                aria-haspopup="true" aria-expanded="false" aria-controls="accountMenuPanel"
                title="${name}">
          ${avatar}
          <span class="avatar-caret" aria-hidden="true"></span>
          <span class="visually-hidden">Account menu for ${name}</span>
        </button>
        <div class="account-menu-panel" id="accountMenuPanel" role="menu"
             aria-labelledby="accountMenuButton" hidden>
          <div class="account-menu-head">
            <span class="account-menu-name">${name}</span>
            <span class="account-menu-note">signed in via ${provider}</span>
          </div>
          <button class="account-menu-item" type="button" role="menuitem" data-open-accounts>
            Add or remove ESO accounts
          </button>
          ${hasAccounts
            ? `<a class="account-menu-item" href="/owner/requests" role="menuitem">
              Process Requests
            </a>`
            : ''}
          <form method="post" action="/logout">
            <button class="account-menu-item" type="submit" role="menuitem">Log out</button>
          </form>
        </div>
      </div>`;
  }

  if (!showSignedOut) {
    return '';
  }

  return signInButtons(providers);
}

// The signed-out call to action. The header uses it, and so does the first-run page,
// which is why it is its own function.
function signInButtons(providers) {
  if (!providers || providers.length === 0) {
    return '';
  }

  const buttons = providers
    .map((provider) => {
      const key = escapeHtml(provider.key);
      const mark =
        provider.key === 'google'
          ? `<svg class="provider-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
          </svg>`
          : provider.key === 'discord'
            ? `<svg class="provider-mark provider-mark-discord" viewBox="0 0 127.14 96.36" aria-hidden="true" focusable="false">
              <path fill="#ffffff" d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/>
            </svg>`
            : `<span class="discord-mark">&#9670;</span>`;

      return `
      <a class="discord-button auth-button-${key}" href="/auth/${key}">
        ${mark} Sign in with ${escapeHtml(provider.label)}
      </a>`;
    })
    .join('');

  return `<div class="auth-buttons">${buttons}</div>`;
}

// One password box, with the eye that shows what was typed. The button is a plain
// `type="button"`, so it can never submit the form, and `/password-toggle.js` does the
// switching by rewriting the input's type; with scripting off the button does nothing
// and the box stays hidden, which is what a password box does anyway.
//
// Two pictures rather than one that turns over: an open eye while the text is showing,
// the same eye struck through while it is hidden. `aria-pressed` carries that state for
// a screen reader, so the icon is never the only thing saying which way the box is.
function passwordField({ id, label, name, autocomplete, minlength = 0, hint = '' }) {
  return `
        <div class="auth-field">
          <label for="${id}">${label}</label>
          <span class="password-field" data-password-field>
            <input id="${id}" type="password" name="${name}" autocomplete="${autocomplete}"
                   ${minlength ? `minlength="${minlength}" ` : ''}maxlength="200" required>
            <button class="password-toggle" type="button" data-reveal-password
                    aria-pressed="false" aria-label="Show the password" title="Show the password">
              <svg class="password-eye" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M1.75 12S5.6 5.5 12 5.5 22.25 12 22.25 12 18.4 18.5 12 18.5 1.75 12 1.75 12Z"
                      fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
                <circle cx="12" cy="12" r="3.1" fill="none" stroke="currentColor" stroke-width="1.7"/>
              </svg>
              <svg class="password-eye-off" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M2.5 2.5 21.5 21.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
                <path d="M9.9 5.9A10.6 10.6 0 0 1 12 5.5c6.4 0 10.25 6.5 10.25 6.5a18.4 18.4 0 0 1-3.9 4.4M6.1 7.7A18 18 0 0 0 1.75 12S5.6 18.5 12 18.5a10.9 10.9 0 0 0 3.9-.7"
                      fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
              </svg>
            </button>
          </span>
          ${hint ? `<span class="auth-hint">${hint}</span>` : ''}
        </div>`;
}

// The way in that needs nothing configured: an address and a password. The sign-up form
// sits behind a summary so the page asks for one thing at a time, and both forms post
// normally, so they work with the scripts switched off.
//
// Creating an account asks for the password twice. It is the one password nobody can
// reset from memory: a typo here would be discovered at the next sign-in, after the
// address had already been answered at. Both boxes are read by the server too, so a
// browser with scripting off is held to the same rule.
function emailSignInPanel() {
  return `
    <div class="auth-email">
      <form class="auth-form" method="post" action="/auth/email">
        <label class="auth-field">
          <span>Email</span>
          <input type="email" name="email" autocomplete="email" spellcheck="false"
                 maxlength="254" required>
        </label>
        ${passwordField({
          id: 'signin-password',
          label: 'Password',
          name: 'password',
          autocomplete: 'current-password',
        })}
        <button class="primary-button" type="submit">Sign In</button>
      </form>
      <details class="auth-signup">
        <summary>New here? Create an account</summary>
        <form class="auth-form" method="post" action="/auth/email/signup">
          <label class="auth-field">
            <span>Email</span>
            <input type="email" name="email" autocomplete="email" spellcheck="false"
                   maxlength="254" required>
          </label>
          ${passwordField({
            id: 'signup-password',
            label: 'Password',
            name: 'password',
            autocomplete: 'new-password',
            minlength: 8,
            hint: 'At least 8 characters. This address is where request answers are sent.',
          })}
          ${passwordField({
            id: 'signup-confirm',
            label: 'Type it again',
            name: 'confirm',
            autocomplete: 'new-password',
            minlength: 8,
            hint: 'Both boxes have to match, so a typo cannot lock you out.',
          })}
          <button class="primary-button" type="submit">Create account</button>
        </form>
      </details>
      <p class="auth-hint"><a href="/auth/email/forgot">Forgot your password?</a></p>
    </div>`;
}

/**
 * The form that asks where to send a link. It says the same thing whether or not the
 * address has an account, because a form that answers differently is a way to find out
 * which addresses are registered here.
 */
export function renderForgotPasswordPage({ user = null, providers = [], notice = '' } = {}) {
  return pageShell({
    user,
    providers,
    title: 'Forgot your password \u00b7 ItemShare',
    scripts: false,
    content: `
      <section class="card">
        <h2>Forgot your password?</h2>
        <p class="muted">
          Type the email address you signed up with and we will send a link to choose a
          new password. The link works once and expires in 30 minutes.
        </p>
        ${notice ? `<p class="status err">${escapeHtml(notice)}</p>` : ''}
        <form class="auth-form" method="post" action="/auth/email/forgot">
          <label class="auth-field">
            <span>Email</span>
            <input type="email" name="email" autocomplete="email" spellcheck="false"
                   maxlength="254" required>
          </label>
          <button class="primary-button" type="submit">Send the link</button>
        </form>
        <div class="actions center"><a href="/">Back to the list</a></div>
      </section>`,
  });
}

/**
 * The form a reset link opens. The token is in the address bar, so it is posted back to
 * the same place and the page never needs scripts.
 */
export function renderResetPasswordPage({ token, user = null, providers = [], notice = '' }) {
  return pageShell({
    user,
    providers,
    title: 'Choose a new password \u00b7 ItemShare',
    scripts: false,
    // No item list on this page, but two password boxes with an eye each.
    passwordToggle: true,
    content: `
      <section class="card">
        <h2>Choose a new password</h2>
        <p class="muted">
          This link works once. When it is used, every other reset link for this address
          stops working.
        </p>
        ${notice ? `<p class="status err">${escapeHtml(notice)}</p>` : ''}
        <form class="auth-form" method="post" action="/auth/email/reset/${escapeHtml(token)}">
          ${passwordField({
            id: 'reset-password',
            label: 'New password',
            name: 'password',
            autocomplete: 'new-password',
            minlength: 8,
            hint: 'At least 8 characters.',
          })}
          ${passwordField({
            id: 'reset-confirm',
            label: 'Type it again',
            name: 'confirm',
            autocomplete: 'new-password',
            minlength: 8,
          })}
          <button class="primary-button" type="submit">Set the password</button>
        </form>
      </section>`,
  });
}

/** Every way in, in one place: the OAuth buttons that are configured, a divider saying
 * the email form below is the other way, then the email form itself. */
function signInPanel(providers) {
  const oauth = signInButtons(providers);

  return `<div class="auth-panel">${oauth}${
    oauth ? '<div class="auth-or"><span>OR</span></div>' : ''
  }${emailSignInPanel()}</div>`;
}

/**
 * What somebody sees before signing in, and the only thing they see.
 *
 * The list, the filters and the counts all describe other people's stashes, so there is
 * nothing to show until the site can name who is looking. Every way in is here: the
 * configured sign-in providers, the email form, and the demo pair.
 */
export function renderSignInPage({ providers = [], notice = '' } = {}) {
  return pageShell({
    providers,
    centered: true,
    signedOutHeader: false,
    title: 'Sign in \u00b7 ItemShare',
    content: `
      <div class="solo-card">
        <section class="card">
          <h2>Sign in to see what your guild shares</h2>
          <p class="muted">
            ItemShare shows what guildmates are willing to hand over, and which character
            to mail it to. That is only safe to show to somebody the site can name, so the
            list opens after signing in - with Discord, with Google, or with an email
            address and a password.
          </p>
          ${notice ? `<p class="status err">${escapeHtml(notice)}</p>` : ''}
          ${signInPanel(providers)}
          <p class="auth-hint">
            Then upload your <code>ItemShareSavedVars.lua</code>, so the site knows which
            guilds you are in. Until you do there is nothing to compare against.
          </p>
          <aside class="demo-callout">
            <p class="demo-callout-title">Just looking? Try the Demo!</p>
            <p class="demo-callout-body">
              Sign in with <strong>demo@example.com</strong> and the password
              <strong>demo</strong>.
            </p>
          </aside>
        </section>
      </div>`,
  });
}

function statusCard({ dbError, providers, user }) {
  if (dbError) {
    return `
      <section class="card card-error">
        <h2>Database unavailable</h2>
        <p class="muted">${escapeHtml(dbError)}</p>
        <p class="muted">Check MARIADB_HOST, MARIADB_USER and MARIADB_PASSWORD in <code>.env</code>, then reload.</p>
      </section>`;
  }

  if (!user) {
    return `
      <section class="hero">
        <p class="eyebrow">Your guild. Every spare.</p>
        <h1 class="hero-title">One file.<br>Every spare item in your guild.</h1>
        <p class="hero-lead">
          Upload the file the ItemShare addon writes and your guildmates can see exactly
          what you are willing to share. They ask for a stack, and you get an email
          telling you what to mail and which character to send it to.
        </p>
        ${signInPanel(providers)}
        <p class="hero-note">
          Signing in asks for your email address. That is what we collect: it ties your ESO
          accounts to you, and it is where the note goes when someone answers your request.
        </p>
        <ol class="steps">
          <li class="step">
            <span class="step-num">01</span>
            <h3>Drop your file</h3>
            <p>Upload <code>ItemShareSavedVars.lua</code> from your ESO SavedVariables folder.</p>
          </li>
          <li class="step">
            <span class="step-num">02</span>
            <h3>See what is spare</h3>
            <p>Every item your guildmates are willing to share, filtered by type or owner.</p>
          </li>
          <li class="step">
            <span class="step-num">03</span>
            <h3>Reserve a stack</h3>
            <p>Reserve some of a stack. Nothing is sent until you press Send Requests; then the owner is emailed what to mail and to whom.</p>
          </li>
        </ol>
        <p class="hero-footnote">
          Every upload replaces your guilds and items in full, so this is always a live
          picture of what is spare right now.
        </p>
      </section>`;
  }

  return '';
}

function guildChips(guilds) {
  if (!guilds || guilds.length === 0) {
    return `<p class="muted">No guilds recorded yet. Upload a file from ItemShare 1.3.0 or newer to record your guild membership.</p>`;
  }

  const chips = guilds
    .map((guild) => `<span class="chip">${escapeHtml(guild.guild_name || 'Unknown guild')}</span>`)
    .join('');

  return `<div class="chips">${chips}</div>`;
}

// The addon itself. `dl<id>/` is ESOUI's stable "latest file" download: it redirects to
// whatever the current version is, so the link cannot go stale the way a versioned file
// name would. The info page is the one to read before installing.
export const ESOUI_ADDON_ID = 4533;
export const ESOUI_DOWNLOAD_URL = `https://www.esoui.com/downloads/dl${ESOUI_ADDON_ID}/`;

/**
 * Where to get the addon: in the header, on every page, signed in or not.
 *
 * The site has nothing to read without the file the addon writes, so the download sits in
 * the top bar beside the brand rather than in a paragraph low on a card. It is one link -
 * the latest file from ESOUI - which keeps the line short and leaves the space to its
 * left for whatever else the header carries next.
 */
function addonDownloads() {
  return `
      <a class="addon-download" href="${ESOUI_DOWNLOAD_URL}" target="_blank" rel="noreferrer noopener"
         title="Download the latest ItemShare file from ESOUI">Download ItemShare AddOn</a>`;
}

/**
 * The sign-in address, or the fact that there is none.
 *
 * The demo has a real address on its person row (demo@example.com, on the reserved
 * documentation domain) and signs in with it, so it is shown the way any other account's
 * is - address, then whether the site has verified it - rather than as an address the
 * provider declined to share. A provider that returns no address still says so.
 */
export function emailLine(user) {
  if (!user) {
    return '';
  }

  const address = user.email || (user.isDemo ? DEMO_EMAIL : '');
  const email = address ? escapeHtml(address) : 'not shared with this site';
  const verified = address
    ? user.emailVerified || user.isDemo
      ? 'verified'
      : 'unverified'
    : '';

  return `<span class="meta-value email-value">${email}${verified ? ` <span class="meta-note">(${verified})</span>` : ''}</span><span class="meta-label">Sign-in email</span>`;
}

// One row per attached account, with Remove at the bottom of the row: what somebody needs
// to see is which names are theirs, and the one control that undoes it.
function accountRows(accounts) {
  return (accounts || [])
    .map((account) => {
      const lastUpload = account.lastUpload
        ? `${escapeHtml(account.lastUpload.uploaded_at)} &middot; ${escapeHtml(
            account.lastUpload.source_file || 'upload'
          )}`
        : 'never uploaded';

      // A guild id and an @handle only mean something beside the server they live on, so
      // the platform and megaserver are shown together where the account is. Unknown is
      // said rather than hidden: a name attached by hand has no file behind it yet.
      const where = serverLabel(account);
      const server = where
        ? `<span class="meta-note">${escapeHtml(where)}</span>`
        : `<span class="meta-note">platform and server not known yet</span>`;

      return `
      <li class="account-row">
        <div class="account-row-main">
          <span class="account-row-name">${escapeHtml(account.accountName)} ${server}</span>
          <span class="account-row-meta">${Number(account.itemCount || 0)} items &middot;
            ${Number(account.guildCount || 0)} guilds &middot; ${lastUpload}</span>
          <div class="account-row-guilds">${guildChips(account.guilds)}</div>
        </div>
        <form class="account-remove" method="post" action="/accounts/remove">
          <input type="hidden" name="accountName" value="${escapeHtml(account.accountName)}">
          <button class="filter-clear" type="submit">Remove</button>
        </form>
      </li>`;
    })
    .join('');
}

/**
 * The dialog that owns the ESO account list: what is attached, the way to remove one, and
 * the box that attaches another.
 *
 * Somebody who has signed in and attached nothing has nothing to ask with, so the dialog
 * opens by itself for them (`data-accounts-auto`, read by app.js). It can be dismissed -
 * the profile menu reopens it - because a dialog that cannot be closed is a broken page.
 */
function accountsModal(accounts, user, servers = []) {
  if (!user) {
    return '';
  }

  const list = Array.isArray(accounts) ? accounts : [];
  const empty = list.length === 0;

  // A name typed by hand has to say where it plays: a guild id and an @handle are only
  // unique inside one platform and megaserver, and a request addressed to the wrong one
  // is addressed to nobody. The choices are what the database already holds, plus the two
  // megaservers the addon writes, so the form works before the first upload.
  const choices = serverChoices(servers);
  const platformOptions = choices.platforms
    .map((choice) => `<option value="${choice.value}">${escapeHtml(choice.label)}</option>`)
    .join('');
  const worldOptions = choices.worlds
    .map((world) => `<option value="${escapeHtml(world)}">${escapeHtml(world)}</option>`)
    .join('');

  return `
    <div class="modal-backdrop" id="accountsModal" data-accounts-modal${
      empty ? ' data-accounts-auto' : ' hidden'
    }>
      <div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="accountsTitle">
        <div class="modal-head">
          <h2 id="accountsTitle">${
            empty ? 'Which ESO account is yours?' : `Your ESO accounts (${list.length})`
          }</h2>
          <button class="modal-close" type="button" data-close-accounts aria-label="Close">&times;</button>
        </div>
        <p class="muted">
          ${
            empty
              ? 'Tell the site your ESO account name so a request can say which character to mail. You do not have to share anything yourself.'
              : 'These are the ESO accounts attached to this sign-in. Removing one only unlinks it: what that account has already shared stays where it is.'
          }
        </p>
        ${empty ? '' : `<ul class="account-list">${accountRows(list)}</ul>`}
        <form class="account-add" method="post" action="/accounts/add">
          <label class="auth-field">
            <span>ESO account name</span>
            <input type="text" name="accountName" autocomplete="off" spellcheck="false"
                   maxlength="96" placeholder="@YourAccountName" required>
          </label>
          <p class="auth-hint">Lower case, with an @ in front - the site adds the @ if you leave it out.</p>
          <div class="account-add-server">
            <label class="auth-field">
              <span>Platform</span>
              <select name="platform" required>
                <option value="" selected disabled>Choose one</option>
                ${platformOptions}
              </select>
            </label>
            <label class="auth-field">
              <span>Server</span>
              <select name="worldName" required>
                <option value="" selected disabled>Choose one</option>
                ${worldOptions}
              </select>
            </label>
          </div>
          <p class="auth-hint">Where the account plays - a request has to name the megaserver to mail the item on.</p>
          <div class="modal-actions">
            <button class="primary-button" type="submit">${
              empty ? 'Attach account' : 'Attach another account'
            }</button>
          </div>
        </form>
        <div class="meta-row email-line">${emailLine(user)}</div>
      </div>
    </div>`;
}

function accountsCard(accounts, user, servers = []) {
  const list = Array.isArray(accounts) ? accounts : [];

  // A visitor has no sign-in and nothing attached, so there is nothing about accounts to
  // tell them: the hero above already offers the way in.
  if (!user && list.length === 0) {
    return '';
  }
  const names = list
    .map((account) => {
      const where = serverLabel(account);

      return `<span class="chip">${escapeHtml(account.accountName)}${
        where ? ` <span class="meta-note">${escapeHtml(where)}</span>` : ''
      }</span>`;
    })
    .join('');

  const empty = `
      <p class="muted">
        No ESO account is attached to this sign-in yet. Add the name from
        <strong>Add or remove ESO accounts</strong> in the menu, or upload your
        <code>ItemShareSavedVars.lua</code> file and every account in it is attached for you.
      </p>
      <p class="muted">
        Until then you can read everything that is shared, but you cannot ask for any of it:
        a request has to say which character to mail.
      </p>`;

  return `
    <section class="card">
      <h2>Your ESO accounts</h2>
      ${
        list.length === 0
          ? empty
          : `        <div class="chips">${names}</div>`
      }
      <div class="meta-row email-line">${emailLine(user)}</div>
    </section>
    ${accountsModal(list, user, servers)}`;
}

// The windows the Added filter offers. Anything else in the address bar falls back
// to "any time" rather than reaching the query.
const ADDED_WINDOWS = [
  { days: '1', label: 'The last day' },
  { days: '7', label: 'The last 7 days' },
  { days: '30', label: 'The last 30 days' },
];


/**
 * A column heading that is also the sort control: clicking it sorts by that column
 * and clicking it again reverses. The arrow says which way round it is now, and
 * aria-sort says the same thing to a screen reader.
 */
function sortHeader(label, field, filters, className = '') {
  const sort = (filters && filters.sort) || 'type';
  const dir = (filters && filters.dir) === 'desc' ? 'desc' : 'asc';
  const active = sort === field;
  const arrow = active ? (dir === 'asc' ? ' \u25b2' : ' \u25bc') : '';
  const ariaSort = active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';

  // A button, not a link: the order is cycled on the page and remembered in a cookie,
  // so the address bar never carries a sort. data-dir tells the script where this
  // heading is now, which is what makes ascending, descending, off possible.
  return `<th${className ? ` class="${className}"` : ''} aria-sort="${ariaSort}"><button class="sort-link${
    active ? ' active' : ''
  }" type="button" data-sort="${escapeHtml(field)}" data-dir="${
    active ? dir : ''
  }">${escapeHtml(label)}${arrow}</button></th>`;
}

/**
 * A filter that can hold several values: a menu of checkboxes rather than a select,
 * so picking a second type adds to the first instead of replacing it.
 */
function filterMenu({ name, label, allLabel, options, chosen }) {
  const picked = new Set(chosen);
  const count = chosen.length;
  const summary = count === 0 ? allLabel : count === 1 ? chosen[0] : `${count} chosen`;

  const rows = options
    .map(
      (option) => `
            <label class="filter-option"><input type="checkbox" name="${escapeHtml(
              name
            )}" value="${escapeHtml(option.value)}"${
              picked.has(option.value) ? ' checked' : ''
            } data-filter><span>${escapeHtml(option.label)}</span></label>`
    )
    .join('');

  return `
      <div class="filter filter-menu" data-filter-menu data-all-label="${escapeHtml(allLabel)}">
        <span class="filter-label">${escapeHtml(label)}</span>
        <details class="filter-dropdown">
          <summary class="filter-select"><span class="filter-select-label">${escapeHtml(
            summary
          )}</span><span class="filter-count"${count > 0 ? '' : ' hidden'}>${count}</span></summary>
          <div class="filter-menu-list" role="group" aria-label="${escapeHtml(label)}">${rows}
          </div>
        </details>
      </div>`;
}

/**
 * One removable chip per value that is switched on, on a single long row: what is
 * narrowing the list stays visible even when the menus above it are closed.
 */
function filterChips({ types, owners }) {
  const chips = [
    ...types.map((value) => ({ name: 'type', value })),
    ...owners.map((value) => ({ name: 'owner', value })),
  ];

  const markup = chips
    .map(
      (chip) => `<button class="filter-chip" type="button" data-chip-filter="${escapeHtml(
        chip.name
      )}" data-chip-value="${escapeHtml(chip.value)}" aria-label="Remove the ${escapeHtml(
        chip.value
      )} filter" title="Remove the ${escapeHtml(chip.value)} filter">${escapeHtml(
        chip.value
      )}<span aria-hidden="true">&times;</span></button>`
    )
    .join('');

  return `<div class="filter-chips" data-filter-chips>${markup}</div>`;
}

export function filterBar(facets, filters) {
  const types = facets?.types || [];
  const owners = facets?.owners || [];
  const active = filters || {};
  const chosenTypes = filterList(active.type);
  const chosenOwners = filterList(active.owner);
  const search = String(active.search || '');
  const added = String(active.added || '');

  if (types.length === 0 && owners.length === 0) {
    return '';
  }

  const addedOptions = ADDED_WINDOWS.map(
    (window) =>
      `<option value="${window.days}"${added === window.days ? ' selected' : ''}>${window.label}</option>`
  ).join('');

  // Filters apply as soon as they change (app.js), so there is no button to forget
  // to press. The submit button exists for the one case that needs it: scripts off.
  return `
    <form class="filters" method="get" action="/" data-filters>
      ${filterMenu({
        name: 'type',
        label: 'Type',
        allLabel: 'All types',
        options: types.map((entry) => ({ value: entry.name, label: `${entry.name} (${entry.total})` })),
        chosen: chosenTypes,
      })}
      ${filterMenu({
        name: 'owner',
        label: 'Offered by',
        allLabel: 'Anyone',
        options: owners.map((owner) => ({ value: owner, label: owner })),
        chosen: chosenOwners,
      })}
      <label class="filter">
        <span class="filter-label">Added</span>
        <select name="added" data-filter>
          <option value="">Any time</option>${addedOptions}
        </select>
      </label>
      <label class="filter filter-search">
        <span class="filter-label">Item name</span>
        <input type="search" name="q" data-filter value="${escapeHtml(search)}" placeholder="sword, ring, motif...">
      </label>
      <noscript><button class="primary-button filter-button" type="submit">Filter</button></noscript>
      <button class="filter-clear" type="button" data-clear-filters>Clear filters</button>
      ${filterChips({ types: chosenTypes, owners: chosenOwners })}
    </form>`;
}

function itemIcon(item) {
  return Number(item.has_icon) === 1
    ? `<img class="item-icon" src="/icons/${escapeHtml(item.icon_key)}.png" alt="" width="24" height="24" loading="lazy">`
    : `<span class="item-icon item-icon-empty" aria-hidden="true"></span>`;
}

// A name carries its own card rather than a link: everything the addon captured
// travels in the data attributes, so the first paint needs no request at all, and
// app.js asks /item-tip for the description and set bonuses and adds them when they
// arrive. The name keeps its quality colour and stays plain text, so a reader who
// is scanning a list never has a link underlined under the pointer.
function itemName(item) {
  const name = escapeHtml(item.item_name);
  const id = Number(item.item_id) || 0;
  const set = String(item.set_name || '').trim();
  const meta = metaLine([
    item.item_type_name,
    item.trait,
    item.enchant_name ? `Enchant: ${item.enchant_name}` : '',
    Number(item.required_cp) > 0 ? `CP ${Number(item.required_cp)}` : '',
    Number(item.required_level) > 0 ? `Level ${Number(item.required_level)}` : '',
  ]);
  const attributes = `data-item-tip data-tip-name="${name}" data-tip-item="${id}" data-tip-color="${qualityColor(
    item.quality
  )}"${set ? ` data-tip-set="${escapeHtml(set)}"` : ''}${
    meta ? ` data-tip-meta="${meta}"` : ''
  }`;

  return `<span class="item-name-link" ${attributes} tabindex="0">${name}</span>`;
}

// A detail earns its place only when it says something. The addon stores a "0" for
// every getter that answered with a number, and "0" is not a label, so those are
// dropped rather than printed next to the set name.
function metaLine(parts) {
  return parts
    .filter((part) => part !== null && part !== undefined && !['', '0'].includes(String(part).trim()))
    .map((part) => escapeHtml(part))
    .join(' &middot; ');
}

// The account alone. The character is already named by the Location column ("Inventory
// (Character)"), so repeating it here said the same thing twice in the same row.
function ownerCell(item) {
  return `<span class="owner">${escapeHtml(item.account_name)}</span>`;
}

// Guild names are deliberately absent: every row on this page is already there
// because the viewer and the owner share a guild.

/**
 * What is free and what is held. Both sides come from the same subtraction, so they
 * can never add up to more than the owner reported: five copies with two asked for
 * shows three free and two held, and a request that is still being picked counts as
 * held because somebody is standing on it.
 */
function availability(item) {
  const total = Number(item.item_count) || 0;
  const reserved = Math.min(Math.max(Number(item.reserved) || 0, 0), Math.max(total, 0));
  // Copies already mailed but still inside the uploaded count. They are neither free
  // nor reserved - they are gone - so they come off the top until the next file leaves
  // them out, at which point they are simply part of the smaller total instead.
  const delivered = Math.min(
    Math.max(Number(item.delivered) || 0, 0),
    Math.max(total - reserved, 0)
  );
  return { total, reserved, delivered, free: Math.max(0, total - reserved - delivered) };
}

/**
 * The owner's own reserve, as a note rather than a number in Free. Free and Held
 * already describe what the site will hand out; this says why the stack looks
 * smaller than the owner's bag does, and it is the only place the reserve appears.
 */
function reserveNote(item) {
  const reserve = Math.max(0, Number(item.reserve_quantity) || 0);

  if (reserve === 0) {
    return '';
  }

  const held = Math.max(0, Number(item.held_quantity) || 0);
  const detail = held > 0 ? ` of ${held}` : '';

  return `<span class="reserved-note" title="The owner keeps these back, so they are not offered">keeping ${reserve} back${detail}</span>`;
}

/**
 * Copies handed over since the owner's last upload, which the stored count still
 * carries. Saying it out loud is what keeps QUANTITY from looking wrong to the owner,
 * who knows they mailed those four yesterday.
 */
function deliveredNote(item) {
  const delivered = availability(item).delivered;

  if (delivered <= 0) {
    return '';
  }

  return `<span class="reserved-note" title="Already fulfilled; the next upload leaves them out of the count">${delivered} sent</span>`;
}

/**
 * The button that starts a request, or the reason there is none. data-max is what is
 * left after everything held - unsent baskets included - so the dialog can never
 * offer a copy that is not there.
 */
/**
 * How many requests are still waiting on a row the owner is looking at, one per request
 * rather than one per copy: "2 pending requests" is two people to mail, however many
 * copies each of them asked for.
 *
 * The number falls on its own - an answered, cancelled or timed-out request is no longer
 * pending - and a row with none says nothing at all. The hover carries the list behind
 * the number, because the count says how many and not who.
 */
function pendingNote(item) {
  const waiting = Array.isArray(item.pending_requests) ? item.pending_requests : [];
  const count = waiting.length || Number(item.request_count) || 0;

  if (count === 0) {
    return '';
  }

  const rows = waiting
    .map(
      (request) =>
        `${request.requester} asked for ${request.quantity} cop${
          Number(request.quantity) === 1 ? 'y' : 'ies'
        }`
    )
    .join('\n');

  return `<span class="reserved-note pending-note"${
    rows ? ` title="${escapeHtml(rows)}"` : ''
  }>${count} pending request${count === 1 ? '' : 's'}</span>`;
}

/**
 * Why a request button can be disabled, said the same way everywhere: what is missing,
 * and that uploading is not the same as sharing. Compact on purpose - it is a hover.
 */
const UPLOAD_HINT =
  'Upload ItemShareSavedVars.lua so we know who you are - you do not need to share anything.';

// The same column for somebody signed in who has not attached an ESO account yet.

/**
 * The request button for somebody the site has no ESO account for. It is drawn, so the
 * column still reads as a column, and disabled, because there is no account to credit a
 * request to. The explanation sits on the wrapper: a disabled button does not reliably
 * raise a tooltip of its own, and the button ignores the pointer so the hover reaches it.
 */
function requestGate(label, hint = UPLOAD_HINT) {
  return `<span class="request-gate" title="${escapeHtml(
    hint
  )}"><button class="request-button" type="button" disabled aria-disabled="true">${escapeHtml(
    label
  )}</button></span>`;
}

function requestCell(item, { mine, canRequest = true, hint = UPLOAD_HINT }) {
  if (mine) {
    return pendingNote(item);
  }

  if (!canRequest) {
    return requestGate('Reserve', hint);
  }

  const { total, free } = availability(item);
  // Copies still unclaimed are the only thing a request can ask for, and the dialog
  // measures everything against that number: what is in the basket is already counted
  // in RESERVED, and asking again adds to it rather than starting a second row.
  const held = Math.max(0, Number(item.my_draft_quantity) || 0);

  // Your own basket, not the guild's reservations: RESERVED already carries that number.
  // This one is only true while the row is an unexpired draft, so the server counts it
  // from live drafts rather than from anything stored on the item.
  const basketNote =
    held > 0 ? `<span class="basket-note">${held} in your basket</span>` : '';

  // Every copy is spoken for - by other people, by this person, or both - so there is
  // nothing left to ask for and the button goes until one comes back. Only `free` decides
  // this: a copy sitting in your own basket does not make the item available again.
  if (free <= 0) {
    return `<span class="claimed-note">All Currently Reserved</span>${basketNote}`;
  }

  return `<button class="request-button" type="button" data-request data-kind="inventory" data-id="${Number(
    item.id
  )}" data-max="${free}" data-stack="${total}" data-held="${held}" data-name="${escapeHtml(
    item.item_name || ''
  )}">Reserve</button>${basketNote}`;
}

function inventoryRows(items, { mine, canRequest = true, hint = UPLOAD_HINT }) {
  return items
    .map((item) => {
      const unattributed = !item.guild_names;
      const details = metaLine([
        item.style_name,
        item.enchant_name ? `Enchant: ${item.enchant_name}` : '',
        Number(item.required_cp) > 0 ? `CP ${Number(item.required_cp)}` : '',
        Number(item.required_level) > 0 ? `Level ${Number(item.required_level)}` : '',
      ]);

      const added = sharedTimeCell(item.first_seen_at_iso || item.first_seen_at);
      // Where the owner's copy sat the last time their file was saved. It is a column
      // rather than a sentence in the detail line because it is something people
      // scan for ("is it in the bank or on them?"), and it changes on its own when
      // they move the item and save again.
      const location = String(item.location_label || '').trim();

      // Every copy is held by a request that was actually sent: the row has nothing
      // left to offer and is only here for the few seconds it takes to fade out.
      const exhausted = Number(item.exhausted) > 0;

      return `
        <tr data-item-key="inv:${escapeHtml(item.item_key_hash || item.id)}"${
          exhausted ? ` data-exhausted="${Number(item.exhausted)}"` : ''
        }>
          <td>
            <div class="item-cell">
              ${itemIcon(item)}
              <div class="item-cell-text">
                <span class="item-name" style="color:${qualityColor(item.quality)}">${itemName(item)}</span>
                ${mine && unattributed ? '<span class="own-tag">Unattributed</span>' : ''}
                ${reserveNote(item)}
                ${deliveredNote(item)}
                ${details ? `<span class="item-meta">${details}</span>` : ''}
              </div>
            </div>
          </td>
          <td class="seen-cell relative" title="When ${escapeHtml(
            item.account_name
          )} first shared it">${added || '&mdash;'}</td>
          <td class="num">${availability(item).total}</td>
          <td class="num held-cell">${availability(item).reserved || ''}</td>
          <td class="num">${availability(item).free}</td>
          <td>${escapeHtml(item.item_type_name || '')}</td>
          <td>${escapeHtml(item.trait || '')}</td>
          <td class="location-cell">${location ? escapeHtml(location) : '&mdash;'}</td>
          <td>${ownerCell(item)}</td>
          <td class="action-cell">${requestCell(item, { mine, canRequest, hint })}</td>
        </tr>`;
    })
    .join('');
}

function typeGroups(items) {
  const groups = new Map();

  for (const item of items) {
    const name = item.item_type_name || 'Other';
    if (!groups.has(name)) {
      groups.set(name, []);
    }
    groups.get(name).push(item);
  }

  // The types always run A-Z. The sort orders the rows inside a type and nothing more:
  // somebody looking for Weapons should not have to work out which heading the current
  // order has moved it under, and "newest first" says nothing about where Apparel
  // belongs. This is why the entry list is sorted here rather than left in the order the
  // rows arrived, which is what let the sort drag the headings around.
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'));
}

/**
 * The small control above the table: whether the rows sit under their type, or run as
 * one list. Two drawn pictures rather than a word alone - a heading over its rows, and a
 * plain list of equal rows - and the word beside it says the same thing.
 */
export function groupToggle(filters = {}) {
  const grouped = filters.group !== false;
  const title = grouped
    ? 'Grouped by type. Click for one list.'
    : 'One list. Click to group by type.';
  const word = grouped ? 'Grouped by type' : 'One list';
  const icon = grouped
    ? `<svg class="group-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <rect x="1" y="2" width="14" height="3" rx="1" fill="currentColor"/>
            <rect x="3.5" y="6.4" width="11.5" height="2" rx="1" fill="currentColor" opacity="0.55"/>
            <rect x="1" y="9.4" width="14" height="3" rx="1" fill="currentColor"/>
            <rect x="3.5" y="13.8" width="11.5" height="2" rx="1" fill="currentColor" opacity="0.55"/>
          </svg>`
    : `<svg class="group-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <rect x="1" y="2.4" width="14" height="2.4" rx="1.2" fill="currentColor"/>
            <rect x="1" y="6.8" width="14" height="2.4" rx="1.2" fill="currentColor"/>
            <rect x="1" y="11.2" width="14" height="2.4" rx="1.2" fill="currentColor"/>
          </svg>`;

  return `<div class="list-tools">
      <button class="group-toggle" type="button" data-group-toggle aria-pressed="${grouped}" title="${title}">
        ${icon}<span class="group-word">${word}</span>
      </button>
    </div>`;
}

export function inventoryTable(items, { mine, canRequest = true, filters = {}, hint = UPLOAD_HINT }) {
  // Grouping and sorting answer different questions: grouping decides whether the type
  // headings are drawn, and the column headings decide the order of everything in them.
  // Keeping them apart is what lets somebody ask for newest-first inside their types, or
  // for one flat alphabetical list, without one choice cancelling the other.
  const grouped = filters.group !== false;

  const body = grouped
    ? typeGroups(items)
        .map(
          ([typeName, rows]) => `
        <tr class="type-row">
          <td colspan="10">${escapeHtml(typeName)} <span class="type-count">(${rows.length})</span></td>
        </tr>
        ${inventoryRows(rows, { mine, canRequest, hint })}`
        )
        .join('')
    : inventoryRows(items, { mine, canRequest, hint });

  return `
    ${groupToggle(filters)}
    <div class="table-shell">
      <table>
        <thead>
          <tr>
            ${sortHeader('ITEM', 'name', filters)}
            ${sortHeader('ADDED', 'added', filters, 'seen-cell relative')}
            <th class="num" title="Copies the owner's saved file reported, all of them claimable">OFFERED</th>
            <th class="num" title="Copies a request stands on, sent or still in a basket">RESERVED</th>
            <th class="num" title="Copies left to claim - the most anyone can ask for">AVAILABLE</th>
            <th>Type</th>
            <th>Trait</th>
            <th class="location-cell" title="Where the owner's copy was when they last saved; it follows the item when they move it">Location</th>
            <th>Offered by</th>
            <th class="action-cell"><span class="visually-hidden">Ask for it</span></th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

/**
 * A standing offer is a promise for one copy at a time, so it carries the same two
 * numbers as any shared row: one to hand over, and one reserved from the moment
 * somebody asks for it. The file no longer says whether a copy is in a bag - schema 4
 * keeps an always-shared item out of `sharedItems` - so there is no stock left to check
 * and the offer is a row until its copy is claimed.
 */
function offerAvailability(item) {
  const total = 1;
  const reserved = Math.min(Math.max(Number(item.reserved) || 0, 0), total);
  return { total, reserved, free: Math.max(0, total - reserved) };
}

function offerRequestCell(item, { mine, canRequest = true, hint = UPLOAD_HINT }) {
  if (mine) {
    return pendingNote(item);
  }

  if (!canRequest) {
    return requestGate('Reserve one', hint);
  }

  return `<button class="request-button" type="button" data-request data-kind="offer" data-id="${Number(
    item.id
  )}" data-max="1" data-stack="1" data-name="${escapeHtml(
    item.item_name || ''
  )}">Reserve one</button>`;
}

// An offer whose copy is already claimed is not a row at all: the owner may hold more,
// but an offer hands out one at a time, so a second row would be refused on the click.
function offerRows(items, { mine, canRequest = true, hint = UPLOAD_HINT }) {
  return (items || [])
    .filter((item) => offerAvailability(item).free > 0)
    .map((item) => {
      const { total, free, reserved } = offerAvailability(item);
      const keep = Math.max(0, Number(item.reserve_quantity) || 0);
      const details = metaLine([
        item.item_type_name,
        item.trait,
        'one at a time',
        keep > 0 ? `keeping ${keep} back` : '',
      ]);

      const added = sharedTimeCell(item.first_seen_at_iso || item.first_seen_at);

      return `
        <tr data-item-key="offer:${escapeHtml(item.item_key_hash || item.id)}">
          <td>
            <div class="item-cell">
              ${itemIcon(item)}
              <div class="item-cell-text">
                <span class="item-name" style="color:${qualityColor(item.quality)}">${itemName(item)}</span>
                ${details ? `<span class="item-meta">${details}</span>` : ''}
              </div>
            </div>
          </td>
          <td class="seen-cell relative" title="When the owner first shared it">${added || '&mdash;'}</td>
          <td class="num">${total}</td>
          <td class="num held-cell">${reserved || ''}</td>
          <td class="num">${free}</td>
          <td>${ownerCell(item)}</td>
          <td class="action-cell">${offerRequestCell(item, { mine, canRequest, hint })}</td>
        </tr>`;
    })
    .join('');
}

function offerTable(items, { mine, canRequest = true, filters = {}, hint = UPLOAD_HINT }) {
  return `
    <div class="table-shell">
      <table>
        <thead>
          <tr>
            ${sortHeader('ITEM', 'name', filters)}
            ${sortHeader('ADDED', 'added', filters, 'seen-cell relative')}
            <th class="num" title="A standing offer is one copy">OFFERED</th>
            <th class="num" title="A request stands on this copy, sent or still in a basket">RESERVED</th>
            <th class="num" title="The copy the owner has in a bag right now">AVAILABLE</th>
            <th>Offered by</th>
            <th class="action-cell"><span class="visually-hidden">Ask for it</span></th>
          </tr>
        </thead>
        <tbody>${offerRows(items, { mine, canRequest, hint })}</tbody>
      </table>
    </div>`;
}

/**
 * Stable identity for one rendered list: the accounts, item types and owners in it.
 * The page embeds it and a live refresh compares it, so a change that adds or
 * removes a filter option rebuilds the page instead of leaving the controls stale.
 */
export function listRegionSignature({ accounts = [], facets = {}, browsingAccount = '' } = {}) {
  const payload = JSON.stringify({
    accounts: (accounts || []).map((account) => account.accountName),
    browsingAccount,
    types: ((facets && facets.types) || []).map((entry) => entry.name),
    owners: (facets && facets.owners) || [],
  });

  return createHash('sha1').update(payload).digest('hex').slice(0, 12);
}

function requestStatusPill(request) {
  const labels = {
    draft: 'Not requested',
    pending: 'Requested',
    cancelled: 'Cancelled',
    fulfilled: 'Fulfilled',
    declined: 'Declined',
    expired: 'Timed out',
  };
  const status = String(request.status || 'pending');

  return `<span class="status-pill status-${escapeHtml(status)}">${escapeHtml(
    labels[status] || status
  )}</span>`;
}

// How many, in the requester's own terms: "2 of 3" after a short handover, so a request
// the owner could only partly fill does not read as though all of it arrived. The ask
// lives in `quantity_requested`; a row written before that column existed falls back to
// what was sent.
function sentLabel(request) {
  const sent = Number(request.quantity) || 1;
  const asked = Number(request.quantity_requested) || sent;

  return asked > sent ? `${sent} of ${asked}` : String(sent);
}

// A request row: the item's picture and trait, who it is from, how many, and what
// became of it. `basket` rows are the ones still in the basket, which are the only
// rows that can leave on their own.
function myRequestRows(requests, { basket = false, showSent = false } = {}) {
  return requests
    .map((request) => {
      const isDraft = request.status === 'draft';
      const removed = basket && request.status === 'cancelled';

      return `
        <tr data-my-request data-request-id="${Number(request.id)}"
            ${basket ? 'data-basket-row="1"' : 'data-history-row="1"'}
            data-status="${escapeHtml(request.status)}"
            data-request-name="${escapeHtml(request.item_name || 'that item')}"
            data-request-reason="${escapeHtml(request.status_reason || '')}">
          <td>
            <div class="item-cell">
              ${itemIcon(request)}
              <div class="item-cell-text">
                <span class="item-name" style="color:${qualityColor(request.quality)}">${escapeHtml(
        request.item_name || 'Item'
      )}</span>
                <span class="item-meta">${metaLine([
                  request.item_type_name,
                  request.trait,
                  !isDraft && request.status !== 'pending' ? request.status_reason : '',
                ])}</span>
              </div>
            </div>
          </td>
          <td><span class="owner">${escapeHtml(request.owner_account_name)}</span></td>
          <td class="num">${sentLabel(request)}</td>
          ${
            showSent
              ? `<td class="sent-cell">${sentTimeCell(request)}</td>`
              : ''
          }
          <td>${requestStatusPill(request)}</td>
          <td class="action-cell">${
            // Only a basket row can be taken back. A sent request is a record: the
            // owner may already have read it and set a copy aside, so there is no
            // Cancel button for it, here or on the server.
            removed
              ? ''
              : isDraft && basket
                ? `<button class="cancel-button" type="button" data-cancel-request data-id="${Number(
                    request.id
                  )}">Cancel</button>`
                : ''
          }</td>
        </tr>`;
    })
    .join('');
}

/** seconds -> m:ss, for the one clock the whole basket shares. */
export function formatCountdown(seconds) {
  const total = Math.max(0, Math.trunc(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The basket: everything picked but not sent, with the one clock they all share.
 *
 * It is separate from the table of sent requests below it because the two mean
 * different things - nobody has been asked for these yet, and the countdown is the
 * whole point of them.
 */
/**
 * The bar that says "you are holding these, send them before the clock runs out".
 *
 * It sits above the tabs rather than inside *Your requests*, because the moment a
 * request is picked is the moment the clock starts: someone who never opens that tab
 * still has to see the timer and the way to send.
 */
function draftBasketBar(drafts, basket) {
  const seconds = Math.max(0, Number(basket?.secondsLeft) || 0);
  const copies = drafts.reduce((sum, row) => sum + (Number(row.quantity) || 1), 0);

  return `
    <div class="draft-basket" data-basket data-items="${drafts.length}"
         data-seconds="${seconds}" data-expires-in="${seconds}">
      <div class="draft-basket-text">
        <strong>${drafts.length} item${drafts.length === 1 ? '' : 's'} reserved - not sent${
          copies > drafts.length ? ` (${copies} copies)` : ''
        }</strong>
        <span class="muted">
          Reserved Items are not fully requested until you send your requests. If not sent
          before reservation expires your items are returned for others to reserve.
        </span>
      </div>
      <div class="draft-basket-actions">
        <span class="countdown" data-countdown aria-label="Time left to send">${formatCountdown(
          seconds
        )}</span>
        <button class="primary-button" type="button" data-submit-requests>Send Requests</button>
      </div>
    </div>`;
}

function requestTable(rows, options = {}) {
  return `
    <div class="table-shell">
      <table>
        <thead>
          <tr><th>Item</th><th>From</th><th class="num">Qty</th>${
            options.showSent ? '<th>Sent</th>' : ''
          }<th>Status</th>
              <th class="action-cell"><span class="visually-hidden">Actions</span></th></tr>
        </thead>
        <tbody>${myRequestRows(rows, options)}</tbody>
      </table>
    </div>`;
}

/**
 * Two lists that mean different things. The basket is what is still held but not
 * asked, including anything removed a moment ago so the removal can be seen; below
 * it is the history of everything actually sent, newest first.
 */
function myRequestsPanel(requests, basketRows = []) {
  const history = requests || [];
  const basket = basketRows || [];
  const live = basket.filter((row) => row.status === 'draft');

  if (history.length === 0 && basket.length === 0) {
    return `<p class="muted">You have not asked for anything yet. Everything other members of your guilds are sharing is on the Request tab, where you can ask for one, for a number, or for the whole stack.</p>`;
  }

  const basketSection =
    basket.length === 0
      ? ''
      : `<h3 class="subhead">In your basket</h3>
    <p class="bag-note">${
      live.length > 0
        ? 'Items are not requested until you click Send Requests.'
        : 'You have no reserved items.'
    }</p>
    ${requestTable(basket, { basket: true })}`;

  const historySection =
    history.length === 0
      ? ''
      : `<h3 class="subhead">Already sent</h3>
    <p class="muted">
      Newest first, and only what you actually sent: a request waiting on its owner, one
      that was handed over (in full or not), one they turned down, or one that was
      cancelled because there was nothing to send. Anything you removed before sending,
      or that timed out, was never asked for and is not here. Times are shown in your own
      time zone; the database keeps them in UTC.
    </p>
    ${requestTable(history, { showSent: true })}`;

  return `${basketSection}${historySection}`;
}

/**
 * The three lists, inside one element the browser can replace without touching the
 * filters, the upload card or the reader's place in a list.
 *
 * Request is what other people share and you can ask for, Offering is your own, and
 * Your requests is what you asked others for and what became of it. The split is why
 * no row needs a "You" tag: which tab it is in already says whose it is.
 */
/**
 * Which of your ESO accounts you are browsing as. It scopes the Request list and it is
 * the character an owner is told to mail, so it is stated on the page rather than
 * buried in a menu. One account is a label, not a choice.
 */
function accountPicker(accounts, selected) {
  // No account yet: there is nothing to browse as and no account a request could be made
  // on behalf of, so the picker is not drawn at all rather than drawn empty.
  if (accounts.length === 0) {
    return '';
  }

  const chosen = accounts.find((account) => account.accountName === selected) || accounts[0];
  const describe = (account) => {
    const guilds = (account.guilds || []).length;
    const where = serverLabel(account);
    const parts = [account.accountName];

    // The server is second so two accounts with the same name can be told apart while
    // choosing, and the guild count follows as it always did.
    if (where) {
      parts.push(where);
    }

    if (guilds > 0) {
      parts.push(`${guilds} guild${guilds === 1 ? '' : 's'}`);
    }

    return parts.join(' \u00b7 ');
  };

  if (accounts.length === 1) {
    return `
      <p class="browsing-picker browsing-single">
        Browsing as <strong>${escapeHtml(describe(chosen))}</strong> \u2014 requests will be made on behalf of this account.
      </p>`;
  }

  const options = accounts
    .map(
      (account) => `
          <option value="${escapeHtml(account.accountName)}"${
            account === chosen ? ' selected' : ''
          }>${escapeHtml(describe(account))}</option>`
    )
    .join('');

  return `
      <form class="browsing-picker" method="post" action="/browsing-account">
        <label class="browsing-label" for="browsingAccount">Browsing as</label>
        <select id="browsingAccount" name="accountName" onchange="this.form.submit()">${options}
        </select>
        <noscript><button class="browsing-go" type="submit">Switch</button></noscript>
        <span class="browsing-hint">Requests will be made on behalf of this account</span>
      </form>`;
}

export function renderListRegion({
  user = null,
  accounts,
  browsingAccount = '',
  sharedItems,
  requestItems,
  alwaysShare,
  requestOffers,
  facets,
  filters,
  requests,
  basket,
  basketRows = [],
}) {
  // No accounts is a real state: somebody signed in who has not uploaded yet, and a
  // visitor who has not signed in at all. The list is theirs to read - it is the reason
  // to sign in - but not to ask from: a request needs an account to be credited to and a
  // name to mail, so every request button is drawn disabled, and the hover says which of
  // those two steps is missing.
  const viewerAccounts = accounts || [];
  const visitor = !user;
  // Everybody can reserve. A visitor's dialog asks for the ESO account to ask from and an
  // address to answer at; somebody signed in with nothing attached is asked for the name
  // at the moment they reserve, and the request itself attaches it to their sign-in.
  // Gating that case made people leave the page to upload a file before asking anything,
  // and uploading is how you share - not how the site knows who is asking.
  const canRequest = true;
  // Whether the site knows which guilds this viewer is in. It decides the wording only;
  // the buttons follow `canRequest`.
  const knowsGuilds = viewerAccounts.length > 0;
  const requestHint = UPLOAD_HINT;
  const myAccounts = new Set(viewerAccounts.map((account) => account.accountName));
  // The account being browsed as decides which guilds the Request list may show; a
  // saved choice that is no longer linked falls back to the oldest account, the same
  // way the server resolves it, so the picker cannot disagree with the list.
  const selected = viewerAccounts.some((account) => account.accountName === browsingAccount)
    ? browsingAccount
    : viewerAccounts[0]?.accountName || '';
  // Offering stays across every account: the point of listing it per account is that a
  // second account's guild must not hide what the first one offers.
  const requestSource = requestItems || sharedItems;
  const requestOfferSource = requestOffers || alwaysShare;
  // A row that has just run out is kept by the server for a few seconds so a live page
  // can fade it. Rendering it left a type heading and a tab count on screen with no row
  // under them, so a page render drops it and every number matches what is visible.
  const onScreen = (items) => (items || []).filter((item) => !(Number(item.exhausted) > 0));
  const requestable = onScreen(requestSource).filter((item) => !myAccounts.has(item.account_name));
  const myItems = onScreen(sharedItems).filter((item) => myAccounts.has(item.account_name));
  // An offer whose copy is already claimed is not a row, so it must not be counted in
  // the tab badge or the line above the tabs either: a count with no row under it is
  // what made the Offering list unreadable.
  const openOffers = (items) =>
    (items || []).filter((item) => offerAvailability(item).free > 0);
  const othersOffers = openOffers(
    (requestOfferSource || []).filter((item) => !myAccounts.has(item.account_name))
  );
  const myOffers = openOffers((alwaysShare || []).filter((item) => myAccounts.has(item.account_name)));
  const myRequests = requests || [];
  const basketList = basketRows || [];
  const unsent = basketList.filter((request) => request.status === 'draft');

  const activeFilters =
    filterList(filters?.type).length > 0 ||
    filterList(filters?.owner).length > 0 ||
    Boolean(filters?.search || filters?.added);
  const requestCount = requestable.length + othersOffers.length;
  const offerCount = myItems.length + myOffers.length;
  const waitingCount =
    unsent.length + myRequests.filter((request) => request.status === 'pending').length;

  // The line above the tabs counts different things, not copies: "9 items" means
  // nine names somebody is offering, however many copies of each they hold.
  const distinctOffered = new Set(
    [...requestable, ...othersOffers].map((item) =>
      Number(item.item_id) > 0
        ? `id:${Number(item.item_id)}`
        : `name:${String(item.item_name || '').toLowerCase()}`
    )
  ).size;

  const empty = (fallback) =>
    `<p class="muted list-empty">${
      activeFilters ? 'No items match those filters. Clear them to see everything.' : fallback
    }</p>`;

  const requestBody =
    requestCount === 0
      ? empty(
          knowsGuilds
            ? `Nothing is being shared by other members of the guilds ${selected} is in right now. Whatever they share appears here on its own.`
            : 'Nothing is being shared right now. Whatever other members share appears here on its own.'
        )
      : `${
          requestable.length > 0
            ? inventoryTable(requestable, { mine: false, canRequest, filters, hint: requestHint })
            : ''
        }${
          othersOffers.length > 0
            ? `<h3 class="subhead">Standing offers</h3>
               <p class="muted">They will hand these out whenever they have one, one copy at a time.</p>
               ${offerTable(othersOffers, { mine: false, canRequest, filters, hint: requestHint })}`
            : ''
        }`;

  const offerBody =
    offerCount === 0
      ? empty(
          'You are not offering anything yet. Upload your file and the items you share in game appear here.'
        )
      : `${myItems.length > 0 ? inventoryTable(myItems, { mine: true, filters }) : ''}${
          myOffers.length > 0
            ? `<h3 class="subhead">Your standing offers</h3>
               ${offerTable(myOffers, { mine: true, filters })}`
            : ''
        }`;

  // Only a signed-in person has an Offering or requests of their own, so a visitor is
  // given the one list that applies to them instead of two tabs that can only say
  // "nothing here yet".
  const ownTabs = visitor
    ? ''
    : `<button class="tab" type="button" role="tab" id="tabOffer" aria-controls="panelOffer"
                    aria-selected="false" tabindex="-1" data-tab="offer">
              Offering <span class="tab-count">${offerCount}</span>
            </button>
            <button class="tab" type="button" role="tab" id="tabMine" aria-controls="panelMine"
                    aria-selected="false" tabindex="-1" data-tab="mine">
              Your requests <span class="tab-count">${waitingCount}</span>
            </button>`;

  const ownPanels = visitor
    ? ''
    : `<div class="list-panel" id="panelOffer" role="tabpanel" aria-labelledby="tabOffer" data-panel="offer" hidden>
          ${offerBody}
        </div>

        <div class="list-panel" id="panelMine" role="tabpanel" aria-labelledby="tabMine" data-panel="mine" hidden>
          ${myRequestsPanel(myRequests, basketList)}
        </div>`;

  return `
    <div class="item-lists" id="itemLists" data-signature="${escapeHtml(
      listRegionSignature({ accounts: viewerAccounts, facets, browsingAccount: selected })
    )}">
      <section class="card">
        ${
          distinctOffered > 0
            ? `<p class="offer-summary">${distinctOffered} different item${
                distinctOffered === 1 ? '' : 's'
              } shared by other members of ${
                !knowsGuilds
                  ? 'the guilds they share with'
                  : viewerAccounts.length > 1
                    ? `${escapeHtml(selected)}&rsquo;s guilds`
                    : 'your guilds'
              }</p>`
            : ''
        }
        ${
          // Signed in, but no ESO account attached yet: the reserve dialog asks for one.
          // A marker rather than a body attribute, so a live refresh keeps it honest.
          !visitor && viewerAccounts.length === 0 ? '<span hidden data-needs-account></span>' : ''
        }
        ${accountPicker(viewerAccounts, selected)}
        <div class="list-head">
          <div class="tabs" role="tablist" aria-label="Item lists">
            <button class="tab" type="button" role="tab" id="tabRequest" aria-controls="panelRequest"
                    aria-selected="true" data-tab="request">
              Request <span class="tab-count">${requestCount}</span>
            </button>
            ${ownTabs}
          </div>
          <span class="live-pill" data-live="wait" hidden>Live</span>
        </div>

        <div class="list-panel" id="panelRequest" role="tabpanel" aria-labelledby="tabRequest" data-panel="request">
          ${requestBody}
        </div>

        ${ownPanels}
      </section>
    </div>`;
}

// One shell for every page. Without this a failed sign-in, a wrong address or a
// cancelled prompt dropped the browser onto a bare line of text with no styling and
// no way back, which reads as a broken site rather than a message.
function pageShell({
  user = null,
  providers = [],
  accounts = [],
  content,
  title = 'ItemShare',
  centered = false,
  // The sign-in buttons belong in the header when nothing else on the page offers them.
  // The first-run page puts the same buttons in its hero, so it says not to repeat them.
  signedOutHeader = true,
  // How long a reservation lives, so the first-hold notice can name the number instead
  // of saying "a few minutes". 0 means the page is not one a hold can start on.
  holdMinutes = 0,
  // Whether this page is being looked at by somebody who is not signed in, which is what
  // tells the request dialog it may have to ask for an account name and an address.
  guest = false,
  // Pages that are a single form and nothing else do not need the item list's script,
  // and a socket on a page reached from an email would open a connection for nothing.
  scripts = true,
  // The eye on a password box is the one part of the item list's script a bare form
  // wants: the page a reset link opens is two password boxes and nothing else.
  passwordToggle = false,
  // The hold bar, built by the page that knows what is in the basket. It rides in the
  // header beside the download link, so the clock and the way to send are in the one
  // place somebody is already looking rather than inside a tab they may never open.
  basketBar = '',
}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body${guest ? ' data-guest-request="1"' : ''}${
  user && user.isDemo ? ' data-demo="1"' : ''
}${
  Number(holdMinutes) > 0 ? ` data-hold-minutes="${Number(holdMinutes)}"` : ''
}>
    <header class="top-bar">
    <div class="top-bar-left">
      <div class="brand">
        <img class="brand-mark" src="/brand/mark.svg" alt="" aria-hidden="true">
        <div class="brand-text">
          <img class="brand-wordmark" src="/brand/wordmark.svg" alt="ItemShare">
          <span class="brand-subtitle">Shared items across your guilds</span>
        </div>
      </div>
      ${addonDownloads()}
    </div>
    ${basketBar}
    ${authArea(user, providers, accounts, { showSignedOut: !centered && signedOutHeader })}
  </header>

  <main class="surface${centered ? ' surface-centered' : ''}">
${user && user.isDemo ? demoBanner() : ''}
${content}
  </main>

  <footer class="footer">      <span>ItemShare &middot; made for the people who keep the guild supplied</span>
  </footer>

  <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>

  ${
    scripts
      ? '<script src="/socket.io/socket.io.js" defer></script>\n  <script src="/app.js" defer></script>'
      : ''
  }
  ${scripts || passwordToggle ? '<script src="/password-toggle.js" defer></script>' : ''}
</body>
</html>`;
}

/**
 * A full page for something that is not the item list: a cancelled sign-in, a
 * provider that is not configured, a wrong address, an upload that failed.
 */
export function renderMessagePage({
  title,
  heading,
  message,
  details = '',
  tone = 'notice',
  user = null,
  providers = [],
  accounts = [],
}) {
  const cardClass = tone === 'error' ? 'card card-error' : 'card card-notice';

  const content = `
    <section class="${cardClass}">
      <h2>${escapeHtml(heading)}</h2>
      <p class="muted">${escapeHtml(message)}</p>
      ${details ? `<p class="muted">${escapeHtml(details)}</p>` : ''}
      <div class="actions">
        <a class="primary-button" href="/">Back to ItemShare</a>
      </div>
    </section>`;

  return pageShell({ user, providers, accounts, content, title: title || `${heading} \u00b7 ItemShare` });
}

// The one drop target on the page. It sits in the upload card on the full page and in
// the same place on the first-run screen, which is why the markup is a function: two
// elements with id="savedvars" would both be found by the script.
function uploadZone() {
  return `
      <label class="drop-zone" id="dropZone" for="savedvars">
        <span class="drop-title">Drop the file here, or click to choose it</span>
        <span class="drop-file" id="fileName">No file selected</span>
        <input id="savedvars" name="savedvars" type="file" accept=".lua,.txt,text/plain">
      </label>`;
}

// The drop target stays on the page for a demo session on purpose: seeing where the
// file would go is part of the picture. What changes is that the card says, before
// anything is dropped on it, that the file will not be read - and app.js shows that
// sentence instead of sending it.
function uploadCard({ demo = false } = {}) {
  return `
    <section class="card">
      <h2>Upload your ItemShareSavedVariables.lua File Here</h2>
      ${
        demo
          ? `<p class="card card-notice" id="demoUploadNotice" role="status">
        Uploading is switched off on a demo account, so this file would not be read and
        nothing in it would be saved. Sign in as yourself - or sign up - to upload your
        saved variables and share your own items.
      </p>`
          : ''
      }
      ${uploadZone()}
    </section>`;
}

/**
 * The half-way house: signed in, but with no ESO account behind the sign-in yet.
 *
 * This is the upload gate. There are no guilds to compare against, so an item list
 * would be every share on the site rather than the ones this person's guilds made, and
 * the one useful thing on the page is the box that changes it.
 */
export function renderUploadPage({ user = null, providers = [] } = {}) {
  return pageShell({
    user,
    providers,
    centered: true,
    title: 'Upload your file \u00b7 ItemShare',
    content: `
      <div class="solo-card">
        <section class="card">
          <h2>One step before the list</h2>
          <p class="muted">
            There is no ESO account behind this sign-in yet, so there are no guilds to
            compare against and nothing the site could safely show you. Upload the file
            the ItemShare addon writes and every account in it is attached to you; after
            that, what your guildmates share appears here.
          </p>
        </section>
        ${uploadCard({ demo: Boolean(user && user.isDemo) })}
      </div>`,
  });
}

/**
 * The one thing a demo session is never in doubt about. It sits above every page,
 * including the messages, because a refusal is easier to understand when the reason is
 * already on the screen.
 */
function demoBanner() {
  return `
    <section class="card card-notice" role="status">
      <h2>Demo mode</h2>
      <p class="muted">
        This is a copy of the site: a demo guild, <strong>Alphabet Mafia</strong> on PC /
        NA Megaserver, with guildmates who keep items here so there is somebody to ask
        and somebody to answer. Everything works - reserving, cancelling, sending,
        answering, changing accounts - but only inside the copy. While this page is open
        those guildmates ask, hand over and re-save their own items, so you can watch the
        site being used; that stops when the demo is closed. No count changes for anybody
        else, no email is ever sent, uploading is switched off and the password cannot be
        reset. Sign up and upload your own file to take part for real.
      </p>
    </section>`;
}

export function renderPage({
  user,
  providers,
  accounts,
  accountServers = [],
  browsingAccount = '',
  sharedItems,
  requestItems,
  alwaysShare,
  requestOffers,
  facets,
  filters,
  requests,
  basket,
  basketRows = [],
  dbError,
}) {
  // Both people the site has no ESO account for - somebody signed in who has not uploaded
  // yet, and a visitor who has not signed in at all - get the lists with every request
  // button disabled: they have no guilds to compare against, so the list is everything
  // that is shared, and for the visitor it is the reason to sign in at all.
  //
  // A database that cannot answer is the whole page: there is nothing else to say.
  if (dbError) {
    return pageShell({
      user,
      providers,
      accounts,
      centered: true,
      content: `<div class="solo-card">${statusCard({ dbError, providers, user })}</div>`,
    });
  }

  // Somebody who is signed in but has no ESO account has not uploaded anything yet, so
  // there is nothing on this page that could be said to be theirs - and the list is the
  // reason to upload. They get the box that changes it and nothing else.
  if (user && Array.isArray(accounts) && accounts.length === 0) {
    return renderUploadPage({ user, providers });
  }

  const bar = filterBar(facets, filters);

  // The hold bar belongs in the header, which every page shares, so it is built here and
  // handed to the shell rather than to the list it used to sit above.
  const unsentRows = (basketRows || []).filter((row) => row.status === 'draft');
  const basketBar = unsentRows.length > 0 ? draftBasketBar(unsentRows, basket) : '';

  const content = `
    ${statusCard({ dbError, providers, user })}

    ${user ? uploadCard({ demo: Boolean(user.isDemo) }) : ''}

    ${accountsCard(accounts, user, accountServers)}

    ${bar ? `<section class="card card-filters">${bar}</section>` : ''}
    ${renderListRegion({
      user,
      accounts,
      browsingAccount,
      sharedItems,
      requestItems,
      alwaysShare,
      requestOffers,
      facets,
      filters,
      requests,
      basket,
      basketRows,
    })}`;

  return pageShell({
    user,
    providers,
    accounts,
    content,
    signedOutHeader: false,
    guest: !user,
    holdMinutes: Number(basket?.holdMinutes) || 0,
    basketBar,
  });
}

/**
 * The form the request email links to, as a page.
 *
 * Mail clients are not browsers: most of them strip a form out of a message. So the
 * same form is rendered here and linked from the email, and it is deliberately plain -
 * one whole number per row, one POST, no script - so it works on a phone, with
 * scripting off, and from a mail client that mangled the message.
 */
export function renderRequestFulfillPage({
  token,
  rows = [],
  notice = '',
  values = new Map(),
  user = null,
  providers = [],
}) {
  const owners = [...new Set(rows.map((row) => row.owner_account_name).filter(Boolean))];
  const requester = rows[0]?.requester_account_name || '';
  const valueFor = (row) =>
    values instanceof Map && values.has(Number(row.id))
      ? String(values.get(Number(row.id)))
      : String(row.asked);

  const body = rows
    .map(
      (row) => `
        <tr>
          <td>
            <div class="item-cell">
              <div class="item-cell-text">
                <span class="item-name" style="color:${qualityColor(row.quality)}">${escapeHtml(
                  row.item_name || 'Item'
                )}</span>
                <span class="item-meta">${metaLine([
                  row.item_type_name,
                  row.trait,
                  row.enchant_name ? `Enchant: ${row.enchant_name}` : '',
                  `${row.asked} asked for`,
                ])}</span>
              </div>
            </div>
          </td>
          <td class="num">
            <form class="fulfill-row" method="post" action="/requests/fulfill/${escapeHtml(token)}">
              <input type="hidden" name="row" value="${Number(row.id)}">
              <input class="fulfill-input" type="number" name="quantity"
                     value="${escapeHtml(valueFor(row))}" min="0" max="${Number(row.asked)}" step="1"
                     inputmode="numeric"
                     aria-label="How many of ${escapeHtml(row.item_name || 'this item')} you sent">
              <button class="fulfill-button" type="submit">Save</button>
            </form>
          </td>
        </tr>`
    )
    .join('');

  const content = `
    <div class="solo-card">
      <section class="card">
        <h2>What did you send?</h2>
        <p class="muted">
          ${escapeHtml(requester || 'Someone')} asked for ${
            rows.length === 1 ? 'this item' : `${rows.length} items`
          } from <strong>${escapeHtml(owners.join(', ') || 'your account')}</strong>. Set the
          number on a row to what you actually mailed and press <strong>Save</strong> on that
          row: each row is recorded on its own, so you can answer the ones you have sent now
          and come back for the rest with the same link. A number of <strong>0</strong> cancels
          that row, because there was nothing to send.
        </p>
        ${notice ? `<p class="status err">${escapeHtml(notice)}</p>` : ''}
        <div class="table-shell fulfill-shell">
          <table>
            <thead>
              <tr><th>Item</th><th class="num">Sent</th></tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
        <p class="fulfill-note">Nothing is recorded until you press Save on that row.</p>
      </section>
    </div>`;

  return pageShell({
    user,
    providers,
    accounts: [],
    content,
    title: 'What did you send? \u00b7 ItemShare',
    centered: true,
    scripts: false,
  });
}

/**
 * What was just recorded, in the words of the row it was recorded on.
 *
 * Answering removes the row, so "1 request fulfilled" confirmed something no longer on
 * screen: which item, how many copies and who asked is the only version the owner can
 * check against what they actually mailed. The counts-only wording is kept for a page
 * loaded by redirect, which carries counts rather than rows.
 */
function answerNotice(answered) {
  const rows = Array.isArray(answered.rows) ? answered.rows.filter(Boolean) : [];
  const distinct = (values) => [
    ...new Set(values.map((value) => String(value || '').trim()).filter(Boolean)),
  ];
  const items = distinct(rows.map((row) => row.itemName));
  const requesters = distinct(rows.map((row) => row.requesterAccount));
  const item = items.length ? items.join(', ') : 'that request';
  const who = requesters.length ? ` for ${requesters.join(', ')}` : '';
  const copies = rows.reduce((sum, row) => sum + (Number(row.sent) || 0), 0);
  const cancelled = Number(answered.cancelled) || 0;
  const fulfilled = Number(answered.fulfilled) || 0;

  if (copies > 0) {
    return `Fulfilled ${copies} \u00d7 ${item}${who}.`;
  }

  // Only when a row is in hand: the redirect carries counts, and naming "that request" as
  // cancelled there would be a sentence about nothing.
  if (cancelled > 0 && rows.length > 0) {
    return `Marked ${item} as not fulfilled${who}, so it is no longer waiting.`;
  }

  return `Recorded: ${fulfilled} request${fulfilled === 1 ? '' : 's'} fulfilled${
    cancelled > 0 ? ` and ${cancelled} cancelled` : ''
  }.`;
}

/**
 * What is waiting on this person's own items, one row per item however many asks stand
 * behind it.
 *
 * It posts to itself and then redirects, so a refresh cannot answer twice, and the rows
 * that were just answered are gone from the list when the page comes back - which is
 * the clearest confirmation there is. Fulfilled and Not fulfilled are the same form: the
 * second one is the first one saved as 0. Asked for as a fragment, the card is what the
 * modal over the item list shows, and its close control closes that instead of leaving.
 */
export function renderOwnerRequestsCard({
  rows = [],
  notice = '',
  answered = null,
  values = new Map(),
}) {
  const valueFor = (row) =>
    values instanceof Map && values.has(Number(row.id))
      ? String(values.get(Number(row.id)))
      : String(row.asked);

  const body = (rows || [])
    .map(
      (row) => `
        <tr>
          <td>
            <div class="item-cell">
              <div class="item-cell-text">
                <span class="item-name" style="color:${qualityColor(row.quality)}">${escapeHtml(
                  row.item_name || 'Item'
                )}</span>
                <span class="item-meta">${metaLine([
                  row.item_type_name,
                  row.trait,
                  row.enchant_name ? `Enchant: ${row.enchant_name}` : '',
                  row.owner_account_name,
                ])}</span>
              </div>
            </div>
          </td>
          <td class="location-cell">${escapeHtml(
            String(row.location_label || '').trim()
          ) || '&mdash;'}</td>
          <td><span class="owner">${escapeHtml(
            (row.requesters || []).join(', ') || 'Unknown account'
          )}</span></td>
          <td class="seen-cell">${localTimeCell(
            row.first_submitted_at,
            row.requests > 1
              ? `${row.requests} asks for this item, the newest at ${localTimeText(
                  row.last_submitted_at
                )}`
              : ''
          )}</td>
          <td class="num">${Number(row.asked)}</td>
          <td class="num fulfill-cell">
            <form class="fulfill-row" method="post" action="/owner/requests">
              <input type="hidden" name="group" value="${Number(row.id)}">
              <input class="fulfill-input" type="number" name="quantity"
                     value="${escapeHtml(valueFor(row))}" min="0" max="${Number(row.asked)}" step="1"
                     inputmode="numeric"
                     aria-label="How many of ${escapeHtml(row.item_name || 'this item')} you sent">
              <button class="fulfill-button" type="submit" name="action" value="save">Fulfilled</button>
              <button class="fulfill-button is-none" type="submit" name="action" value="none">Not fulfilled</button>
            </form>
          </td>
        </tr>`
    )
    .join('');

  const answeredNote = answered
    ? `<p class="status ok">${escapeHtml(answerNotice(answered))}</p>`
    : '';

  return `
    <section class="card" data-owner-requests>
      <div class="card-head">
        <h2>Requests for your items</h2>
        <a class="page-close" href="/" data-owner-requests-close aria-label="Close and return to the list" title="Close">&times;</a>
      </div>
      ${notice ? `<p class="status err">${escapeHtml(notice)}</p>` : ''}
      ${answeredNote}
      ${
        rows.length === 0
          ? '<p class="muted">Nothing is waiting on your items right now.</p>'
          : `<div class="table-shell fulfill-shell">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th class="location-cell" title="Where your copy was sitting when it was asked for, so it can be found and mailed">Stored at</th>
                <th>Mail to</th>
                <th class="seen-cell">Asked</th>
                <th class="num">Requested</th>
                <th class="num">Amount Sent</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
        <p class="fulfill-note">Nothing is recorded until you press Fulfilled on that row.</p>`
      }
      <div class="actions center"><a class="primary-button" href="/">Back to the list</a></div>
    </section>`;
}

/**
 * The same list wrapped in a whole page, for a bookmark or a direct visit. The card is
 * what the modal over the item list fetches, so the two can never drift apart.
 */
export function renderOwnerRequestsPage({
  accounts = [],
  rows = [],
  notice = '',
  answered = null,
  values = new Map(),
  user = null,
  providers = [],
}) {
  return pageShell({
    user,
    providers,
    accounts,
    content: renderOwnerRequestsCard({ rows, notice, answered, values }),
    title: 'Requests for your items \u00b7 ItemShare',
    scripts: false,
  });
}
