// Server rendered pages. Styling lives in public/styles.css and follows the
// GuildSync palette (navy gradient, translucent panels, blue accents).

import { createHash } from 'node:crypto';

import { filterList } from './filters.js';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ESO quality colours: normal, fine, superior, epic, legendary, mythic.
const QUALITY_COLORS = ['#e5e7eb', '#7cb342', '#3b82f6', '#a855f7', '#fbbf24', '#f97316'];

function qualityColor(quality) {
  const index = Number(quality);
  return QUALITY_COLORS[Number.isFinite(index) ? Math.max(0, Math.min(5, index)) : 0];
}

// A date the list can sort on and a person can read. MariaDB hands TIMESTAMP
// columns back as Date objects and the addon writes Unix seconds, so both are
// accepted; the parts are read in local time, because "the day it was added" is a
// calendar question, not a UTC one.
export function dayText(value) {
  const date = parseDate(value);

  if (!date) {
    return '';
  }

  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
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
            ${hasAccounts
              ? `<button class="account-menu-item" type="button" role="menuitem" data-open-accounts>
              ESO accounts
            </button>
            <a class="account-menu-item" href="/owner/requests" role="menuitem">
              Requests for me
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

function statusCard({ dbError, providers, user }) {
  if (dbError) {
    return `
      <section class="card card-error">
        <h2>Database unavailable</h2>
        <p class="muted">${escapeHtml(dbError)}</p>
        <p class="muted">Check MARIADB_HOST, MARIADB_USER and MARIADB_PASSWORD in <code>.env</code>, then reload.</p>
      </section>`;
  }

  if (!providers || providers.length === 0) {
    return `
      <section class="card card-notice">
        <h2>Sign-in is not configured</h2>
        <p class="muted">
          Uploads work, but they will not be linked to a person. Set
          <code>DISCORD_CLIENT_ID</code> / <code>DISCORD_CLIENT_SECRET</code> or
          <code>GOOGLE_CLIENT_ID</code> / <code>GOOGLE_CLIENT_SECRET</code> in
          <code>.env</code> to enable sign-in.
        </p>
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
        ${signInButtons(providers)}
        <p class="hero-note">Signing in only connects your uploads to your ESO accounts.</p>
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
            <h3>Ask for a stack</h3>
            <p>Ask for some of a stack; the owner is emailed what to mail and to whom.</p>
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

function emailLine(user) {
  if (!user) {
    return '';
  }

  const email = user.email ? escapeHtml(user.email) : 'not shared with this site';
  const verified = user.email ? (user.emailVerified ? 'verified' : 'unverified') : '';
  return `<div><span class="meta-label">Sign-in email</span><span class="meta-value">${email}${verified ? ` <span class="meta-note">(${verified})</span>` : ''}</span></div>`;
}

function accountsCard(accounts, user) {
  if (!accounts || accounts.length === 0) {
    return `
      <section class="card">
        <h2>Your ESO accounts</h2>
        <p class="muted">
          No ESO account is linked to your Discord login yet. Upload your
          <code>ItemShareSavedVars.lua</code> file below: every account in that file is
          linked to this login, and each account keeps its own items and guilds.
        </p>
        <p class="muted">
          Nothing is listed until you do. Items are shared through guilds, so until your
          ESO account and its guilds are known there is nobody to share with you.
        </p>
        <div class="meta-row">${emailLine(user)}</div>
      </section>`;
  }

  const totalItems = accounts.reduce((sum, account) => sum + Number(account.itemCount || 0), 0);
  const totalQuantity = accounts.reduce((sum, account) => sum + Number(account.totalQuantity || 0), 0);

  const blocks = accounts
    .map((account) => {
      const uploadVersion = account.lastUpload && account.lastUpload.addon_version
        ? ` &middot; addon ${escapeHtml(account.lastUpload.addon_version)}`
        : '';
      const lastUpload = account.lastUpload
        ? `${escapeHtml(account.lastUpload.uploaded_at)} &middot; ${escapeHtml(account.lastUpload.source_file || 'upload')}${uploadVersion}`
        : 'never';

      const linked = account.link && account.link.user_id
        ? escapeHtml(account.link.display_name || `user #${account.link.user_id}`)
        : 'not linked yet';

      return `
      <div class="account-block">
        <div class="meta-row">
          <div><span class="meta-label">ESO account</span><span class="meta-value">${escapeHtml(account.accountName)}</span></div>
          <div><span class="meta-label">Linked by</span><span class="meta-value">${linked}</span></div>
          <div><span class="meta-label">Last upload</span><span class="meta-value">${lastUpload}</span></div>
          ${emailLine(user)}
        </div>
        <div class="stat-grid">
          <div class="stat"><span class="stat-value">${account.itemCount}</span><span class="stat-label">Items</span></div>
          <div class="stat"><span class="stat-value">${account.totalQuantity}</span><span class="stat-label">Quantity</span></div>
          <div class="stat"><span class="stat-value">${account.guildCount}</span><span class="stat-label">Guilds</span></div>
        </div>
        <div class="subsection">
          <h3>Guilds</h3>
          ${guildChips(account.guilds)}
        </div>
      </div>`;
    })
    .join('');

  const heading = accounts.length === 1 ? 'Your ESO account' : `Your ESO accounts (${accounts.length})`;
  const note = accounts.length > 1
    ? `<p class="muted">
        All ${accounts.length} accounts are tied to this Discord login. Items stay listed
        under the account that holds them, so you can tell which account has what.
      </p>
      <div class="stat-grid">
        <div class="stat"><span class="stat-value">${totalItems}</span><span class="stat-label">Items, all accounts</span></div>
        <div class="stat"><span class="stat-value">${totalQuantity}</span><span class="stat-label">Quantity, all accounts</span></div>
      </div>`
    : '';

  // Behind the profile menu rather than on the page: which accounts are linked, when
  // each last uploaded and which guilds they are in is reference material, not
  // something to read past on the way to the item list.
  return `
    <div class="modal-backdrop" id="accountsModal" data-accounts-modal hidden>
      <div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="accountsTitle">
        <div class="modal-head">
          <h2 id="accountsTitle">${heading}</h2>
          <button class="modal-close" type="button" data-close-accounts aria-label="Close">&times;</button>
        </div>
        <p class="muted">
          The ESO accounts linked to this login, when each last uploaded, and the guilds
          they belong to. Nothing here needs doing while you are asking for items.
        </p>
        ${note}
        ${blocks}
      </div>
    </div>`;
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

function requestCell(item, { mine }) {
  if (mine) {
    return pendingNote(item);
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
    return `<span class="claimed-note">All held</span>${basketNote}`;
  }

  return `<button class="request-button" type="button" data-request data-kind="inventory" data-id="${Number(
    item.id
  )}" data-max="${free}" data-stack="${total}" data-held="${held}" data-name="${escapeHtml(
    item.item_name || ''
  )}">Request</button>${basketNote}`;
}

function inventoryRows(items, { mine }) {
  return items
    .map((item) => {
      const unattributed = !item.guild_names;
      const details = metaLine([
        item.style_name,
        item.enchant_name ? `Enchant: ${item.enchant_name}` : '',
        Number(item.required_cp) > 0 ? `CP ${Number(item.required_cp)}` : '',
        Number(item.required_level) > 0 ? `Level ${Number(item.required_level)}` : '',
      ]);

      const added = dayText(item.first_seen_at);
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
          <td class="seen-cell" title="The day ${escapeHtml(
            item.account_name
          )} first shared it">${added || '&mdash;'}</td>
          <td class="num">${availability(item).total}</td>
          <td class="num held-cell">${availability(item).reserved || ''}</td>
          <td class="num">${availability(item).free}</td>
          <td>${escapeHtml(item.item_type_name || '')}</td>
          <td>${escapeHtml(item.trait || '')}</td>
          <td class="location-cell">${location ? escapeHtml(location) : '&mdash;'}</td>
          <td>${ownerCell(item)}</td>
          <td class="action-cell">${requestCell(item, { mine })}</td>
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

  return [...groups.entries()];
}

function inventoryTable(items, { mine, filters = {} }) {
  // Grouping by type is a sort order of its own; once the list is sorted by name or
  // by date, headings in the middle of it would only interrupt the order asked for.
  const grouped = (filters.sort || 'type') === 'type';

  const body = grouped
    ? typeGroups(items)
        .map(
          ([typeName, rows]) => `
        <tr class="type-row">
          <td colspan="10">${escapeHtml(typeName)} <span class="type-count">(${rows.length})</span></td>
        </tr>
        ${inventoryRows(rows, { mine })}`
        )
        .join('')
    : inventoryRows(items, { mine });

  return `
    <div class="table-shell">
      <table>
        <thead>
          <tr>
            ${sortHeader('Item', 'name', filters)}
            ${sortHeader('Added', 'added', filters, 'seen-cell')}
            <th class="num" title="Copies the owner's saved file reported, all of them claimable">OFFERED</th>
            <th class="num" title="Copies a request stands on, sent or still in a basket">CLAIMED</th>
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
 * numbers as any shared row: one available while the owner has a copy in a bag, and
 * one reserved from the moment somebody asks for it. A row with nothing free is not
 * rendered at all (offerRows drops it), so a standing offer can never show a button
 * that cannot be honoured.
 */
function offerAvailability(item) {
  const total = Number(item.in_inventory) === 1 ? 1 : 0;
  const reserved = Math.min(Math.max(Number(item.reserved) || 0, 0), total);
  return { total, reserved, free: Math.max(0, total - reserved) };
}

function offerRequestCell(item, { mine }) {
  if (mine) {
    return pendingNote(item);
  }

  return `<button class="request-button" type="button" data-request data-kind="offer" data-id="${Number(
    item.id
  )}" data-max="1" data-stack="1" data-name="${escapeHtml(
    item.item_name || ''
  )}">Request one</button>`;
}

// Only offers with a copy to hand over are rows at all: an offer the owner cannot
// honour right now is not shown as an option, so nothing is offered that would be
// refused on the next click.
function offerRows(items, { mine }) {
  return (items || [])
    .filter((item) => offerAvailability(item).free > 0)
    .map((item) => {
      const { total, free, reserved } = offerAvailability(item);
      const keep = Math.max(0, Number(item.reserve_quantity) || 0);
      const details = metaLine([
        item.item_type_name,
        item.trait,
        'one in a bag right now',
        keep > 0 ? `keeping ${keep} back` : '',
      ]);

      const added = dayText(item.first_seen_at);

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
          <td class="seen-cell">${added || '&mdash;'}</td>
          <td class="num">${total}</td>
          <td class="num held-cell">${reserved || ''}</td>
          <td class="num">${free}</td>
          <td>${ownerCell(item)}</td>
          <td class="action-cell">${offerRequestCell(item, { mine })}</td>
        </tr>`;
    })
    .join('');
}

function offerTable(items, { mine, filters = {} }) {
  return `
    <div class="table-shell">
      <table>
        <thead>
          <tr>
            ${sortHeader('Item', 'name', filters)}
            ${sortHeader('Added', 'added', filters, 'seen-cell')}
            <th class="num" title="A standing offer is one copy">OFFERED</th>
            <th class="num" title="A request stands on this copy, sent or still in a basket">CLAIMED</th>
            <th class="num" title="The copy the owner has in a bag right now">AVAILABLE</th>
            <th>Offered by</th>
            <th class="action-cell"><span class="visually-hidden">Ask for it</span></th>
          </tr>
        </thead>
        <tbody>${offerRows(items, { mine })}</tbody>
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
            // Remove or Cancel button for it, here or on the server.
            removed
              ? ''
              : isDraft && basket
                ? `<button class="link-button" type="button" data-cancel-request data-id="${Number(
                    request.id
                  )}">Remove</button>`
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
        <strong>${drafts.length} item${drafts.length === 1 ? '' : 's'} held for you${
          copies > drafts.length ? ` (${copies} copies)` : ''
        }</strong>
        <span class="muted">
          Nobody has been asked yet. Send them before the clock runs out, or the items go
          back to being available to everyone else.
        </span>
      </div>
      <div class="draft-basket-actions">
        <span class="countdown" data-countdown aria-label="Time left to send">${formatCountdown(
          seconds
        )}</span>
        <button class="primary-button" type="button" data-submit-requests>Send requests</button>
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
    <p class="muted">${
      live.length > 0
        ? 'Nobody has been asked yet. Remove anything you change your mind about, or send the lot before the clock runs out.'
        : 'Nothing is waiting to be sent. Items removed a moment ago stay here briefly, marked cancelled, then go.'
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
  const chosen = accounts.find((account) => account.accountName === selected) || accounts[0];
  const describe = (account) => {
    const guilds = (account.guilds || []).length;
    if (guilds === 0) {
      return account.accountName;
    }

    return `${account.accountName} \u00b7 ${guilds} guild${guilds === 1 ? '' : 's'}`;
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
  if (!accounts || accounts.length === 0) {
    return '';
  }

  const myAccounts = new Set(accounts.map((account) => account.accountName));
  // The account being browsed as decides which guilds the Request list may show; a
  // saved choice that is no longer linked falls back to the oldest account, the same
  // way the server resolves it, so the picker cannot disagree with the list.
  const selected = accounts.some((account) => account.accountName === browsingAccount)
    ? browsingAccount
    : accounts[0].accountName;
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
  // An offer with no copy to hand over is not a row, so it must not be counted in the
  // tab badge or the line above the tabs either: a count with no row under it is what
  // made the Offering list unreadable.
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
          `Nothing is being shared by other members of the guilds ${selected} is in right now. Whatever they share appears here on its own.`
        )
      : `${requestable.length > 0 ? inventoryTable(requestable, { mine: false, filters }) : ''}${
          othersOffers.length > 0
            ? `<h3 class="subhead">Standing offers</h3>
               <p class="muted">They will hand these out whenever they have one. A row is only listed while the owner actually has a copy in a bag.</p>
               ${offerTable(othersOffers, { mine: false, filters })}`
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

  return `
    <div class="item-lists" id="itemLists" data-signature="${escapeHtml(
      listRegionSignature({ accounts, facets, browsingAccount: selected })
    )}">
      <section class="card">
        ${unsent.length > 0 ? draftBasketBar(unsent, basket) : ''}
        ${
          distinctOffered > 0
            ? `<p class="offer-summary">${distinctOffered} different item${
                distinctOffered === 1 ? '' : 's'
              } shared by other members of ${
                accounts.length > 1 ? `${escapeHtml(selected)}&rsquo;s guilds` : 'your guilds'
              }</p>`
            : ''
        }
        ${accountPicker(accounts, selected)}
        <div class="list-head">
          <div class="tabs" role="tablist" aria-label="Item lists">
            <button class="tab" type="button" role="tab" id="tabRequest" aria-controls="panelRequest"
                    aria-selected="true" data-tab="request">
              Request <span class="tab-count">${requestCount}</span>
            </button>
            <button class="tab" type="button" role="tab" id="tabOffer" aria-controls="panelOffer"
                    aria-selected="false" tabindex="-1" data-tab="offer">
              Offering <span class="tab-count">${offerCount}</span>
            </button>
            <button class="tab" type="button" role="tab" id="tabMine" aria-controls="panelMine"
                    aria-selected="false" tabindex="-1" data-tab="mine">
              Your requests <span class="tab-count">${waitingCount}</span>
            </button>
          </div>
          <span class="live-pill" data-live="wait" hidden>Live</span>
        </div>

        <div class="list-panel" id="panelRequest" role="tabpanel" aria-labelledby="tabRequest" data-panel="request">
          ${requestBody}
        </div>

        <div class="list-panel" id="panelOffer" role="tabpanel" aria-labelledby="tabOffer" data-panel="offer" hidden>
          ${offerBody}
        </div>

        <div class="list-panel" id="panelMine" role="tabpanel" aria-labelledby="tabMine" data-panel="mine" hidden>
          ${myRequestsPanel(myRequests, basketList)}
        </div>
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
  // Pages that are a single form and nothing else do not need the item list's script,
  // and a socket on a page reached from an email would open a connection for nothing.
  scripts = true,
}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="top-bar">      <div class="brand">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 48 48" focusable="false">
            <rect x="7" y="26" width="34" height="15" rx="4" fill="none" stroke="currentColor" stroke-width="3"/>
            <path d="M24 23V10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
            <path d="M17 16l7-7 7 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M15 33h18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity="0.5"/>
          </svg>
        </span>
        <div class="brand-text">
        <span class="brand-title">ItemShare</span>
        <span class="brand-subtitle">Shared items across your guilds</span>
      </div>
    </div>
    ${authArea(user, providers, accounts, { showSignedOut: !centered })}
  </header>

  <main class="surface${centered ? ' surface-centered' : ''}">
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

function uploadCard() {
  return `
    <section class="card">
      <h2>Upload your ItemShareSavedVariables.lua File Here</h2>
      ${uploadZone()}
    </section>`;
}

export function renderPage({
  user,
  providers,
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
  dbError,
}) {
  // Nothing is listed before the first upload: an account with no guilds shares no
  // guild with anybody, so it has nothing it could legitimately be shown.
  const initialized = Boolean(accounts && accounts.length > 0);
  const signInConfigured = Boolean(providers && providers.length > 0);

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

  // Signed out, or signed in without an ESO account linked yet: one card in the middle
  // of the window saying what to do next, and nothing else. The item lists, the filters
  // and the profile menu would all be empty or pointless in that state, and a page of
  // empty lists reads as a broken site. Anonymous uploads (no sign-in configured at all)
  // keep the ordinary page below.
  if (!initialized && signInConfigured) {
    const content = user
      ? `${accountsCard(accounts, user)}${uploadCard()}`
      : statusCard({ providers, user });

    return pageShell({ user, providers, accounts, centered: true, content: `<div class="solo-card">${content}</div>` });
  }

  const bar = initialized ? filterBar(facets, filters) : '';

  const content = `
    ${statusCard({ dbError, providers, user })}

    ${uploadCard()}

    ${accountsCard(accounts, user)}

    ${bar ? `<section class="card card-filters">${bar}</section>` : ''}
    ${renderListRegion({
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
    })}`;

  return pageShell({ user, providers, accounts, content });
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
    ? `<p class="status ok">Recorded: ${answered.fulfilled} request${
        answered.fulfilled === 1 ? '' : 's'
      } fulfilled${
        answered.cancelled > 0 ? ` and ${answered.cancelled} cancelled` : ''
      }.</p>`
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
