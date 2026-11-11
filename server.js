#!/usr/bin/env node
import { readCookie, readGrouping } from './lib/preferences.js';
import { SORT_FIELDS, parseSortOrder } from './lib/sortQueue.js';
import { keepDemoShelfFull } from './lib/demoShelf.js';
import { errorLine, logLine, warnLine } from './lib/log.js';
// ItemShare upload site: signs in with Discord or Google (both optional),
// accepts ItemShareSavedVars.lua and replaces every shared item for every ESO
// account in the file. Styling follows the GuildSync palette.
//
//   npm start            (reads .env)

import { timingSafeEqual } from 'node:crypto';
import { tokenFingerprint } from './lib/simulateToken.js';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import session from 'express-session';
import multer from 'multer';
import dotenv from 'dotenv';

import { extractShareData } from './lib/savedVars.js';
import { describeConnectionFailure, openDatabase, readConfig } from './lib/database.js';
import { cacheItemIcons, getCachedIcon, resolveMissingIconPaths } from './lib/icons.js';
import { backfillItemIcons } from './lib/iconBackfill.js';
import {
  DEFAULT_HOLD_MINUTES,
  cancelOwnRequest,
  createPasswordReset,
  consumePasswordReset,
  createRequest,
  expireDueDrafts,
  fillKnownIcons,
  getAccountSummary,
  getAlwaysShareForViewer,
  getBasketRows,
  getDraftBasket,
  getFulfillForm,
  getOwnerContacts,
  countOwnerRequests,
  getOwnerRequests,
  getRequesterNotifications,
  getRequesterHistory,
  getSubmittedRequests,
  getSharedItemsForViewer,
  getViewerAccounts,
  listAccountServers,
  getViewerFacets,
  getViewerGuilds,
  createGuildCode,
  findGuildCode,
  findOwnGuild,
  revokeGuildCode,
  listGuildCodes,
  redeemGuildCode,
  getBrowsingAccount,
  issueRequestEmailToken,
  linkAccountToUser,
  recordFulfillment,
  recordOwnerGroupAnswer,
  recordOwnerAnswer,
  reconcileDraftBasket,
  replaceAccounts,
  setBrowsingAccount,
  signInWithProvider,
  submitDrafts,
} from './lib/store.js';
import { readAccountServer } from './lib/serverLabel.js';
import {
  claimHoldsForOwnedAccounts,
  createGuestPerson,
  createPasswordAccount,
  detachAccountFromUser,
  findPasswordLogin,
  notePasswordUsed,
  RESET_TOKEN_MINUTES,
} from './lib/store.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  DEMO_ACCOUNT,
  DEMO_DATABASE,
  DEMO_DISPLAY_NAME,
  DEMO_GUILD,
  DEMO_LOGIN,
  copyDemoData,
  databaseForUser,
  demoDatabaseConfig,
  demoRefusal,
  demoRefusalMessage,
  demoRemovalRestores,
  ensureDemoData,
  findDemoSignIn,
} from './lib/demo.js';
import { filterList } from './lib/filters.js';
import { emailConfig, renderRequestEmail, renderStatusEmail, sendEmail } from './lib/email.js';
import { renderPasswordResetEmail } from './lib/passwordResetEmail.js';
import { getItemTip } from './lib/uesp.js';
import { buildProviders } from './lib/providers.js';
import { isGuildCode, normalizeGuildCode } from './lib/guildCodes.js';
import { normalizeEsoAccountName } from './lib/accountNames.js';
import {
  emailLooksValid,
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  normalizeEmail,
  passwordConfirmationProblem,
  verifyPassword,
} from './lib/passwords.js';
import { attachRealtime } from './lib/realtime.js';
import { demoActivityPause, runDemoActivity } from './lib/demoActivity.js';
import { activeDemoViewers, noteViewer } from './lib/demoPresence.js';
import { MariaDbSessionStore } from './lib/sessionStore.js';
import {
  renderGuidePage,
  renderListRegion,
  renderMessagePage,
  renderForgotPasswordPage,
  renderResetPasswordPage,
  renderGuildCodesPage,
  renderJoinGuildPage,
  renderOwnerRequestsCard,
  renderOwnerRequestsPage,
  renderPage,
  renderRequestFulfillPage,
  renderSignInPage,
  renderUploadPage,
} from './lib/views.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read .env by absolute path. The `dotenv/config` shorthand resolves
// .env against the shell's working directory, so starting the server as
// `node server.js` from another folder found no settings at all and the
// site came up with no session secret and no sign-in providers.
const envPath = path.join(__dirname, '.env');
const hasEnvFile = existsSync(envPath);
dotenv.config({ path: envPath });

// When this process read .env. Every token in the log belongs to this moment, which is
// what makes "I changed .env" visibly different from "this site is using it".
const STARTED_LABEL = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Both providers speak OAuth2 authorization code, so one flow serves both. Only
// the endpoints, scopes and profile fields differ.
// Both providers speak OAuth2 authorization code, so one flow serves both. Their
// definitions - endpoints, scopes, and how a profile becomes our fields - live in
// lib/providers.js, where they can be tested without a real sign-in.
const PROVIDERS = buildProviders(process.env);

const enabledProviders = Object.values(PROVIDERS)
  .filter((provider) => provider.configured)
  .map(({ key, label }) => ({ key, label }));

if (!process.env.SESSION_SECRET) {
  warnLine(
    `SESSION_SECRET is not set${hasEnvFile ? ` in ${envPath}` : `, and there is no .env at ${envPath}`}; ` +
      'using an ephemeral secret, so everyone is signed out on every restart. Make one with\n' +
      '  node -e "console.log(\'SESSION_SECRET=\' + require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
      'and paste the line into .env.'
  );
}
const SESSION_SECRET = process.env.SESSION_SECRET || `itemshare-${Math.random().toString(36).slice(2)}`;

// Staying signed in is the default, not a trick: sessions are kept in MariaDB so a
// restart no longer signs everyone out, and the cookie lasts a month rather than
// half a day. `rolling` renews it on each visit, so an active member never sees a
// login screen for no reason. Log out from the avatar menu is the only way out
// short of clearing cookies, and SESSION_TTL_DAYS=0 is not a thing - one day is
// the floor.
const SESSION_TTL_DAYS = Math.max(Number(process.env.SESSION_TTL_DAYS || 30) || 30, 1);
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

// How long an unsent request holds its item. The window is for gathering a few asks
// and sending them together - not for sitting on somebody's stack - and every add
// or removal starts it again. The sweeper below enforces it even when the person
// has closed the tab.
const HOLD_MINUTES = Math.min(
  Math.max(
    Math.trunc(Number(process.env.REQUEST_HOLD_MINUTES || DEFAULT_HOLD_MINUTES)) ||
      DEFAULT_HOLD_MINUTES,
    1
  ),
  120
);
const sessionStore = new MariaDbSessionStore({ withConnection: withSiteDatabase, ttlMs: SESSION_TTL_MS });

const app = express();
app.use(express.urlencoded({ extended: false }));

// One instance serves both the pages and the socket handshake, so a socket can tell
// who is behind it exactly the way a request does: from the same signed cookie.
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: SESSION_TTL_MS },
});
app.use(sessionMiddleware);

// Every request after this runs in the database its person belongs to, so a demo
// session cannot reach the real guilds even through a route that forgot the rule.
app.use((req, res, next) => {
  const user = req.session ? req.session.user : null;

  requestDatabase.run(databaseForUser(user), next);
});
// A stylesheet taken from a browser cache written before the deploy is the difference
// between green and red answer buttons and two grey boxes with no layout, so it is sent
// with no-cache and revalidated on every page: unchanged costs a 304, changed is seen.
app.get('/styles.css', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('text/css').sendFile(path.join(__dirname, 'public', 'styles.css'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Asking is a writing action too: with no session there is nobody to credit it to and
// nowhere to send the answer, so the guest path that used to make a person on the first
// request sits behind the same door as the list.
app.use((req, res, next) => {
  const user = req.session ? req.session.user : null;

  if (user || req.method !== 'POST' || !req.path.startsWith('/requests')) {
    next();
    return;
  }

  res.status(401).json({ error: 'Sign in before asking for an item.' });
});

// Nothing is readable before signing in. The list, the filters and the counts all
// describe other people's stashes, so the only page without a session is the way in.
// Registered before every route, so a page added later cannot forget the rule.
app.use((req, res, next) => {
  if (req.method !== 'GET' || (req.path !== '/' && req.path !== '/items')) {
    next();
    return;
  }

  const user = req.session ? req.session.user : null;

  if (user) {
    next();
    return;
  }

  // The list fragment is fetched by script on a page that already had a session; when
  // it does not, saying so is better than drawing an empty list.
  if (req.path === '/items') {
    res.status(401).json({ error: 'Sign in to see what your guilds share.' });
    return;
  }

  res.type('html').send(renderSignInPage({ providers: enabledProviders }));
});

// A demo session does everything a member does, inside the demo copy - so the refusals
// here are the few things that would leave it, not the writes themselves. Anything
// blocked is blocked before the route runs.
app.use((req, res, next) => {
  const user = req.session ? req.session.user : null;

  if (!user || !user.isDemo || !demoRefusal(req.method, req.path)) {
    next();
    return;
  }

  const message = demoRefusalMessage(req.path);

  if (req.path === '/upload' || req.path.startsWith('/simulate')) {
    res.status(403).json({ demo: true, error: message });
    return;
  }

  sendPage(req, res, 403, {
    heading: 'Demo mode',
    message,
    details: 'Sign in as a non-demo user to do that on the real site.',
    tone: 'notice',
  });
});

// The number on the avatar: how many asks are waiting on this person's own items.
//
// It is worked out here, once, for the full page loads that draw a header, and hung on the
// session user for this request only. A nested write is not a session change, so nothing
// is written back to the session store - and because every render already receives the
// user, each page shows the count without a query of its own.
app.use((req, res, next) => {
  const user = req.session ? req.session.user : null;
  const accept = req.get('accept') || '';

  // A fragment or a JSON body is fetched by script on a page that already counted, so
  // those are left alone: the badge belongs to a page, not to a live refresh of it.
  if (!user || req.method !== 'GET' || !accept.includes('text/html')) {
    next();
    return;
  }

  withDatabase(async (connection) => {
    const accounts = await getViewerAccounts(connection, user.id);

    return countOwnerRequests(
      connection,
      accounts.map((row) => row.eso_account_name)
    );
  })
    .then((waiting) => {
      req.session.user.pendingRequests = waiting;
      next();
    })
    // A count that could not be read must not cost somebody the page they asked for: the
    // header is drawn without it and the next page tries again.
    .catch(() => next());
});

// Socket.IO rides on the same HTTP server as Express, under /socket.io, so live
// updates need no second port, no extra proxy rule and no separate auth.
const httpServer = createServer(app);
const realtime = attachRealtime({ httpServer, sessionMiddleware });

// A demo reservation is real only inside the demo copy, so it is never announced to
// everybody else's open page. The scope is already known: it is the database this
// request is reading.
const pushChange = realtime.notifyChange;

function notifyItemsChanged(kind, message) {
  // A demo change is real, but only inside the copy. It goes to the demo pages rather
  // than nowhere: they are showing those rows, so they need to refresh too - while an
  // ordinary page must never be told to.
  if (requestDatabase.getStore() === DEMO_DATABASE) {
    realtime.notifyDemoChange(kind, message);
    return;
  }

  pushChange(kind, message);
}

// A demo page says it is still open, which is the only thing that keeps the sandbox's
// other people moving. When the last page stops saying so the activity pauses, and it
// picks up again the next time somebody opens the demo.
const demoViewers = new Map();

app.post('/demo/heartbeat', (req, res) => {
  const user = req.session ? req.session.user : null;

  if (!user || !user.isDemo) {
    res.status(404).json({ error: 'Only a demo session has a sandbox to keep alive.' });
    return;
  }

  noteViewer(demoViewers, req.sessionID, Date.now());
  res.json({ ok: true, demo: true, viewers: demoViewers.size });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
});

function readParam(value) {
  return typeof value === 'string' ? value.trim().slice(0, 120) : '';
}

// How a person is named in the server log and in the live-update line. The ESO account is
// what the guild deals in - a Discord handle means nothing next to "asked for 2 x Soul
// Gem" - so the account the action came from is used, which is the account being browsed
// as whenever there is a choice. The provider username is only the fallback for something
// that has no ESO account attached to it.
function personLabel(user, accountNames) {
  const names = (Array.isArray(accountNames) ? accountNames : [accountNames])
    .map((name) => String(name || '').trim())
    .filter(Boolean);

  if (names.length > 0) {
    return [...new Set(names)].join(' and ');
  }

  return (user && (user.username || user.email)) || 'Someone';
}

/**
 * Emails every owner named in the requests that were just sent, one message per
 * person: the ESO name to mail the items to, then each item with its quantity. A
 * person who owns several ESO accounts gets one message, not one per account.
 *
 * Runs outside the database block on purpose - a slow mail API must not hold a
 * connection, and it must not be able to make a real request look failed.
 */
async function emailOwners({ user, submitted, contacts }) {
  // A demo basket is recorded inside the demo copy and nobody is told: the addresses
  // there are invented placeholders, and mail from a rehearsal must never leave.
  if (user && user.isDemo) {
    // The requests themselves really are recorded, inside the demo copy. The mail is the
    // one part that cannot be rehearsed, so nothing is sent - but the owners a real send
    // would have written to are counted, so the confirmation reads the way it does for
    // everybody else instead of quietly claiming no owner was told.
    const wouldMail = new Set(
      (submitted || [])
        .map((row) => contacts && contacts.get(String(row.owner_account_name)))
        .filter((contact) => contact && contact.email)
        .map((contact) => contact.email)
    ).size;

    logLine(
      `Email: demo session - requests recorded, ${wouldMail} owner${
        wouldMail === 1 ? '' : 's'
      } would have been emailed, nothing sent`
    );
    return { sent: wouldMail, skipped: 0 };
  }

  if (!submitted || submitted.length === 0 || !contacts || contacts.size === 0) {
    return { sent: 0, skipped: 0 };
  }

  const groups = new Map();

  for (const row of submitted) {
    const contact = contacts.get(String(row.owner_account_name));

    if (!contact || !contact.email) {
      continue;
    }

    if (!groups.has(contact.email)) {
      groups.set(contact.email, { email: contact.email, owners: new Set(), items: [] });
    }

    const group = groups.get(contact.email);
    group.owners.add(String(row.owner_account_name));
    group.items.push({
      // The row id is what the answer form sends back; the quantity is what was asked
      // for, so the form opens with the number the owner is answering.
      id: Number(row.id) || 0,
      name: row.item_name || 'Item',
      quantity: Math.max(1, Number(row.quantity_requested) || Number(row.quantity) || 1),
      type: row.item_type_name || '',
      trait: row.trait || '',
      enchant: row.enchant_name || '',
      // Where the owner's copy was when this was shared, so the message can say which
      // container to open. Empty for a standing offer, which has no location of its own.
      location: row.location_label || '',
      quality: Number(row.quality) || 0,
    });
  }

  if (groups.size === 0) {
    return { sent: 0, skipped: 0 };
  }

  const config = emailConfig();

  if (!config.configured) {
    logLine(
      `Email: ${groups.size} request email${groups.size === 1 ? '' : 's'} not sent - ${
        config.reason || 'no mail transport is configured'
      }`
    );
    return { sent: 0, skipped: groups.size };
  }

  const requesterAccount = submitted[0].requester_account_name || '';
  let sent = 0;
  let skipped = 0;

  for (const group of groups.values()) {
    // One token per message: every row in this email is answered by the same page, and
    // the token is the only thing that lets it be answered at all. Without BASE_URL
    // there is no address to build, so the message goes out as a plain list.
    let answerUrl = '';

    if (config.siteUrl) {
      try {
        const token = await withDatabase((connection) =>
          issueRequestEmailToken(
            connection,
            group.items.map((item) => item.id)
          )
        );

        if (token) {
          answerUrl = `${config.siteUrl}/requests/fulfill/${token}`;
        }
      } catch (error) {
        warnLine(`Email: no answer link for ${group.email}: ${error.message}`);
      }
    }

    const message = renderRequestEmail({
      requester: personLabel(user),
      requesterAccount,
      ownerAccount: [...group.owners].join(', '),
      items: group.items,
      siteUrl: config.siteUrl,
      answerUrl,
    });

    const result = await sendEmail({ to: group.email, ...message }, config);

    if (result.ok) {
      sent += 1;
    } else {
      skipped += 1;
      warnLine(`Email: could not email ${group.email}: ${result.error}`);
    }
  }

  logLine(
    `Email: sent ${sent} request email${sent === 1 ? '' : 's'}${
      skipped ? `, ${skipped} failed` : ''
    }${config.overrideTo ? ` (all to ${config.overrideTo}, from EMAIL_OVERRIDE_TO)` : ''}`
  );

  return { sent, skipped };
}

/**
 * Tells the people who asked what became of their request, one message per person.
 *
 * The copies land in the game's mailbox, and the game does not announce them, so the
 * message exists to say there is something to collect - or that there is not, and why.
 * Rows are grouped by address rather than by request, because somebody who asked from
 * two ESO accounts is one person and needs one message.
 *
 * Runs after the answer is committed and never throws: a bad mail day must not turn a
 * handover that was recorded into an error page for the owner.
 */
async function emailAnswered(rows, { demo = false } = {}) {
  const ids = (rows || [])
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (ids.length === 0) {
    return { sent: 0, skipped: 0 };
  }

  // Answering in the demo changes the demo copy only, so the requester - a member whose
  // address was replaced on the way in - hears nothing.
  if (demo) {
    logLine('Email: demo session - answers recorded, no email sent');
    return { sent: 0, skipped: 0 };
  }

  let notices;

  try {
    notices = await withDatabase((connection) => getRequesterNotifications(connection, ids));
  } catch (error) {
    warnLine(
      `Email: could not work out who to tell about ${ids.length} answered request(s): ${error.message}`
    );
    return { sent: 0, skipped: 0 };
  }

  if (!notices || notices.length === 0) {
    return { sent: 0, skipped: 0 };
  }

  const groups = new Map();

  for (const notice of notices) {
    if (!groups.has(notice.email)) {
      groups.set(notice.email, { email: notice.email, name: notice.displayName || '', rows: [] });
    }

    groups.get(notice.email).rows.push(notice);
  }

  const config = emailConfig();

  if (!config.configured) {
    logLine(
      `Email: ${groups.size} answer email${groups.size === 1 ? '' : 's'} not sent - ${
        config.reason || 'no mail transport is configured'
      }`
    );
    return { sent: 0, skipped: groups.size };
  }

  let sent = 0;
  let skipped = 0;

  for (const group of groups.values()) {
    const message = renderStatusEmail({
      requesterName: group.name,
      rows: group.rows,
      siteUrl: config.siteUrl,
    });

    const result = await sendEmail({ to: group.email, ...message }, config);

    if (result.ok) {
      sent += 1;
    } else {
      skipped += 1;
      warnLine(`Email: could not tell ${group.email}: ${result.error}`);
    }
  }

  logLine(
    `Email: sent ${sent} answer email${sent === 1 ? '' : 's'}${skipped ? `, ${skipped} failed` : ''}`
  );

  return { sent, skipped };
}

// Every page the site can end up on uses the same shell, so a cancelled sign-in or
// a wrong address looks like ItemShare rather than a line of unstyled text.
function sendPage(req, res, status, options) {
  res
    .status(status)
    .type('html')
    .send(
      renderMessagePage({
        ...options,
        user: req.session ? req.session.user || null : null,
        providers: enabledProviders,
      })
    );
}

// The guide is the one page that has to work before signing in: it is where the addon and
// the upload step are explained, so a visitor can read what the site is for before
// deciding to sign in at all.
app.get('/how-to', (req, res) => {
  res.type('html').send(
    renderGuidePage({
      user: req.session ? req.session.user || null : null,
      providers: enabledProviders,
    })
  );
});

// Whether the demo copy exists. The activity loop is not started against a database that
// was never built, so a site without the demo runs quietly instead of logging a failure
// every tick.
let demoDatabaseReady = false;

// Migrations run once at startup, in both databases; request connections just use the
// database that belongs to whoever is asking.
async function prepareDatabase() {
  const config = readConfig();
  const { connection, migrations } = await openDatabase(config);

  await connection.end();
  logLine(`Database ready: ${config.database} on ${config.host}:${config.port}`);
  logLine(`Migrations: ${migrations.length ? migrations.join(', ') : 'already up to date'}`);

  // The demo sign-in lives in its own database - a real person, one ESO account, one
  // guild and a shelf of items, made here, once, rather than on the first page view -
  // so nothing a demo session does can reach the real rows. A failure must not stop the
  // site: everything else works without it.
  let demoConfig = null;
  let demoConnection = null;

  try {
    // Dropped and built again from the same migrations on every start, then seeded: the
    // demo copy always matches the schema the site is running and never carries anything
    // over from an earlier run, so a restart is also how it gets reset.
    demoConfig = demoDatabaseConfig(config);
    const opened = await openDatabase(demoConfig, { recreate: true });
    demoConnection = opened.connection;

    // Filled from the site's own rows before the demo's curated guild goes on top, so a
    // visitor can walk through several guilds, real-looking items and requests rather
    // than a handful of rows - with every person anonymised on the way in.
    const copied = await copyDemoData(demoConnection, { sourceDatabase: config.database });
    const demo = await ensureDemoData(demoConnection);
    demoDatabaseReady = true;

    logLine(
      `Demo database: ${demoConfig.database} on ${demoConfig.host}:${demoConfig.port} ` +
        `(recreated, ${copied.copied} table${copied.copied === 1 ? '' : 's'} copied from ${config.database}` +
        `${copied.failed.length ? `, ${copied.failed.length} failed` : ''}; ` +
        `migrations: ${opened.migrations.length ? opened.migrations.length : 'none pending'})`
    );

    for (const failure of copied.failed) {
      warnLine(`Demo database: could not copy ${failure.table} - ${failure.error}`);
    }
    logLine(
      `Demo sign-in: ${demo.created ? 'created' : 'already there'}, ` +
        `${demo.seeded ? 'items written' : 'items already there'} (demo@example.com / demo)`
    );
    logLine(
      `Demo cast: ${demo.cast.seeded.length + demo.cast.kept.length} guildmate${
        demo.cast.seeded.length + demo.cast.kept.length === 1 ? '' : 's'
      } sharing into ${DEMO_GUILD.name}` +
        (demo.cast.seeded.length ? ` (added ${demo.cast.seeded.join(', ')})` : ' (already there)')
    );
  } catch (error) {
    warnLine(`Demo database: not ready - ${error.message}`);
  } finally {
    if (demoConnection) {
      await demoConnection.end();
    }
  }
}

// Which database a request opens depends on who is asking: a demo session reads the
// demo copy, everybody else the real one. The choice is carried in async context, so
// the routes and the store helpers that take a connection stay unchanged.
const requestDatabase = new AsyncLocalStorage();

async function withDatabaseOn(database, handler) {
  const config = { ...readConfig(), database };
  const { connection } = await openDatabase(config, { migrate: false });

  try {
    return await handler(connection, config);
  } finally {
    await connection.end();
  }
}

// Sessions always live in the real database: one has to be read before the site knows
// who is asking, and a demo session has to survive a restart like any other.
async function withSiteDatabase(handler) {
  return withDatabaseOn(readConfig().database, handler);
}

// A single short lived connection per request keeps the app simple: the traffic
// here is one person uploading one file at a time.
async function withDatabase(handler) {
  return withDatabaseOn(requestDatabase.getStore() || readConfig().database, handler);
}

const ADDED_WINDOWS = new Set(['1', '7', '30', 'last-chance']);

// The sort order is a reading preference, not a filter: it is kept in a small cookie so
// the address bar stays a plain link to the filters, safe to share or bookmark. The
// cookie holds a queue of columns - `name:asc,type:desc` - read back by lib/sortQueue.js,
// so several headings can be on at once. A ?sort= still wins when it is present, so an
// older bookmark, which only knows one column, keeps behaving.
const SORT_COOKIE = 'itemshare_sort';

// Grouping is its own preference, for the same reason: turning the type headings off
// should not disturb the order somebody chose from the column headings.
const GROUP_COOKIE = 'itemshare_group';


function readFilters(query, sortCookie = '', groupCookie = '') {
  const added = readParam(query.added);
  const asked = readParam(query.sort);
  const askedDir = readParam(query.dir) === 'desc' ? 'desc' : 'asc';

  // The order is a queue of columns, so a second heading can break the ties the first
  // leaves. The address bar still wins when it names a column - an older bookmark knows
  // only one, which is a queue of one - and the cookie answers otherwise.
  const order = SORT_FIELDS.includes(asked)
    ? [{ field: asked, dir: askedDir }]
    : parseSortOrder(sortCookie);

  return {
    // Several types or owners at once arrive as repeated parameters, so they stay
    // lists all the way into the query and the chips under the filter row.
    type: filterList(query.type),
    owner: filterList(query.owner),
    search: readParam(query.q),
    // Only the values the list actually offers get through, so a hand-typed ?sort=
    // or ?added= falls back to the default instead of reaching the query.
    added: ADDED_WINDOWS.has(added) ? added : '',
    order,
    // Headings are drawn while this is true, whatever the order is.
    group: readGrouping(groupCookie),
  };
}

// One person can own several ESO accounts; every account linked to them contributes
// guilds, and the items stay labelled with the account that holds them. The session
// copy is the fallback for a site running with sign-in turned off.
async function viewerAccountNames(req, connection, user) {
  let names = [];

  if (user) {
    const linked = await getViewerAccounts(connection, user.id);
    names = linked.map((row) => row.eso_account_name);
  }

  if (names.length === 0 && Array.isArray(req.session.accountNames)) {
    names = req.session.accountNames.slice();
  }

  return names;
}

// The item list is loaded twice: once as part of the page, and once on its own when
// a live update says something changed. Both go through here, so a pushed refresh
// can never disagree with a page load about who is allowed to see what.  // One person can own several ESO accounts and each is in its own guilds. They browse
  // as one of them: that account decides what the Request list shows and it is the
  // character an owner is told to mail. A remembered choice only counts while the
  // account is still linked, so an unlinked one falls back instead of hiding the site.
  function browsingAccountFor(accountNames, saved) {
    const chosen = String(saved || '').trim();

    return accountNames.includes(chosen) ? chosen : accountNames[0] || '';
  }

  async function collectViewerData(req, filters) {
  const user = req.session ? req.session.user || null : null;

  const data = {
    user,
    providers: enabledProviders,      accounts: [],
      browsingAccount: '',
      sharedItems: [],
      requestItems: [],
      alwaysShare: [],
      requestOffers: [],
    requests: [],
    basket: { count: 0, quantity: 0, secondsLeft: 0, holdMinutes: HOLD_MINUTES },
    basketRows: [],
    facets: { types: [], owners: [] },
    filters,
    dbError: null,
    accountServers: [],
  };

  try {
    await withDatabase(async (connection) => {
      const accountNames = await viewerAccountNames(req, connection, user);

      // The servers the form offers: what is already recorded, read for every page so a
      // newly added server appears in the list the next time the dialog opens.
      data.accountServers = await listAccountServers(connection);

      // Signed-in accounts only browse their matching guild/platform/server shares.
      // An account with no recorded guilds is prompted to upload its addon file.

      for (const accountName of accountNames) {
        data.accounts.push({
          accountName,
          ...(await getAccountSummary(connection, accountName)),
          guilds: await getViewerGuilds(connection, [accountName]),
        });
      }        data.browsingAccount = browsingAccountFor(
          accountNames,
          user ? await getBrowsingAccount(connection, user.id) : ''
        );

        // Request is fetched twice on purpose: once for the chosen account, whose
        // guilds are the only ones its list may show, and once across every account
        // for My Inventory, where nothing a second account shares should disappear.
        const requestScope = data.browsingAccount ? [data.browsingAccount] : accountNames;

        // The basket note on a row is read by person, not by the account the row belongs
        // to, so the signed-in person's id is what has to go down to the list.
        const viewerUserId = user ? user.id : 0;

        data.facets = await getViewerFacets(connection, requestScope);
        data.sharedItems = await getSharedItemsForViewer(connection, accountNames, {
          ...filters,
          viewerUserId,
        });
        data.requestItems = await getSharedItemsForViewer(connection, requestScope, {
          ...filters,
          viewerUserId,
        });
        data.alwaysShare = await getAlwaysShareForViewer(connection, accountNames, filters);
        data.requestOffers = await getAlwaysShareForViewer(connection, requestScope, filters);
      // A hold follows the account it was asked from. Reading the basket without this
      // leaves the state the item list already complains about: a copy held by a person
      // this sign-in is not, with nothing to send and nothing to cancel. It runs on a
      // page load because that is what happens after every sign-in, account change and
      // upload, and it matches nothing at all once the state is right.
      if (user) {
        const claimed = await claimHoldsForOwnedAccounts(connection, { userId: user.id });

        if (claimed > 0) {
          logLine(
            `Basket: ${claimed} held item${claimed === 1 ? '' : 's'} returned to the account owner`
          );
        }
      }

      if (user && data.browsingAccount) {
        const checked = await reconcileDraftBasket(connection, {
          userId: user.id, accountName: data.browsingAccount,
        });
        if (checked.cancelled > 0) {
          notifyItemsChanged('request', `${checked.cancelled} reservations no longer match the selected account`);
        }
      }
      data.requestHistory = user ? await getRequesterHistory(connection, user.id, req.query?.historyPage) : null;
      data.requests = data.requestHistory?.rows || [];
      data.basketRows = user ? await getBasketRows(connection, user.id) : [];
      data.basket = user
        ? await getDraftBasket(connection, user.id, HOLD_MINUTES)
        : { count: 0, quantity: 0, secondsLeft: 0, holdMinutes: HOLD_MINUTES };
    });
  } catch (error) {
    data.dbError = error.message;
  }

  return data;
}  app.get('/', async (req, res) => {
    res
      .type('html')
      .send(renderPage(await collectViewerData(req, readFilters(
      req.query,
      readCookie(req.headers.cookie, SORT_COOKIE),
      readCookie(req.headers.cookie, GROUP_COOKIE)
    ))));
  });

  // Choosing the account to browse as. A plain form POST, so it still works with the
  // scripts switched off, and it redirects back to the list instead of answering JSON.
  app.post('/browsing-account', async (req, res) => {
    const user = req.session ? req.session.user || null : null;
    const requested = String(req.body.accountName || '').trim();

    if (!user) {
      res.redirect(303, '/');
      return;
    }

    try {
      await withDatabase(async (connection) => {
        // Ownership is checked against the database, never taken from the form: an
        // account name is not a secret, but browsing as someone else's is not allowed.
        const linked = await getViewerAccounts(connection, user.id);

        if (!linked.some((row) => row.eso_account_name === requested)) {
          const error = new Error('That ESO account is not linked to your sign-in.');
          error.statusCode = 400;
          throw error;
        }

        await setBrowsingAccount(connection, user.id, requested);
        const checked = await reconcileDraftBasket(connection, {
          userId: user.id, accountName: requested,
        });
        if (checked.cancelled > 0) {
          notifyItemsChanged('request', `${checked.cancelled} reservations released after changing browsing account`);
        }
      });
    } catch (error) {
      res
        .status(error.statusCode || 500)
        .type('html')
        .send(
          renderMessagePage({
            title: 'Browsing account \u00b7 ItemShare',
            heading: 'That account is not yours',
            message: error.message,
            tone: 'error',
            user,
            providers: enabledProviders,
            accounts: [],
          })
        );
      return;
    }

    res.redirect(303, '/');
  });

// The live update: the same list the page was built from, as a fragment, using the
// filters this browser already has. A non-200 means "leave the screen alone" - a
// database hiccup must not replace a good list with an error card.
app.get('/items', async (req, res) => {    const data = await collectViewerData(req, readFilters(
      req.query,
      readCookie(req.headers.cookie, SORT_COOKIE),
      readCookie(req.headers.cookie, GROUP_COOKIE)
    ));

  if (data.dbError) {
    res.status(503).json({ error: data.dbError });
    return;
  }

  res.set('Cache-Control', 'no-store');
  res.type('html').send(renderListRegion(data));
});

// Asking for an item. The quantity is picked in a dialog, so this answers in JSON
// and the page refreshes its own lists; the socket tells everyone else.
//
// Signing in is not required to ask. The first request from somebody the site has never
// met carries the two things a request actually needs - the ESO account it is made from
// and an address to send the answer to - and those are enough to make a person. The
// session remembers it, so the second request asks nothing.

// Anonymous requests are the one way this site could be used to send mail to people who
// never asked for it, so new guest people are counted per connection: more than anybody
// needs, far fewer than a script wants. In memory on purpose - a restart clearing it
// costs nothing, and the alternative is another table nobody reads.
const GUEST_PER_HOUR = 5;
const GUEST_WINDOW_MS = 60 * 60 * 1000;
const guestWindows = new Map();

function guestRequestAllowed(key, now = Date.now()) {
  const cutoff = now - GUEST_WINDOW_MS;
  const hits = (guestWindows.get(key) || []).filter((at) => at > cutoff);

  if (hits.length >= GUEST_PER_HOUR) {
    guestWindows.set(key, hits);
    return false;
  }

  hits.push(now);
  guestWindows.set(key, hits);

  if (guestWindows.size > 5000) {
    for (const [entry, times] of guestWindows) {
      if (times.every((at) => at <= cutoff)) {
        guestWindows.delete(entry);
      }
    }
  }

  return true;
}

async function makeGuestPerson({ accountName, email, passwordHash }) {
  return withDatabase(async (connection) => {
    // The name shown and put in live-update text is the ESO account, never the address:
    // the address is the one thing on this site that must not reach anybody else.
    const person = await createGuestPerson(connection, {
      email,
      accountName,
      displayName: accountName,
      passwordHash,
    });

    if (!person.created) {
      // Two refusals that need different advice: an address that already signs in belongs
      // to somebody, while a taken ESO account would file the request under another
      // person's character.
      const error = new Error(
        person.reason === 'email'
          ? 'That email address already has an account here. Sign in with it, or use another address.'
          : `${accountName} is attached to a different sign-in. Sign in with that account, or ask from the ESO account name you play.`
      );
      error.statusCode = 409;
      throw error;
    }

    return {
      id: person.userId,
      provider: 'guest',
      providerLabel: 'a guest request',
      username: accountName,
      email,
      emailVerified: false,
      avatarUrl: '',
    };
  });
}

app.post('/requests', async (req, res) => {
  let user = req.session ? req.session.user || null : null;

  if (!user) {
    const accountName = normalizeEsoAccountName(req.body && req.body.accountName);
    const email = normalizeEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '');
    const confirm = String((req.body && req.body.confirm) || '');

    if (!accountName || !emailLooksValid(email)) {
      res.status(400).json({
        error:
          'Say which ESO account you play, where to send the answer, and a password you can sign back in with.',
        needsGuest: true,
      });
      return;
    }

    // Checked before the hash so a typo is answered as a typo rather than as a failure,
    // and so the cost of scrypt is never spent on something too short to keep.
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      res.status(400).json({
        error: `Use a password of at least ${MIN_PASSWORD_LENGTH} characters, so you can sign back in to see this request.`,
        needsGuest: true,
      });
      return;
    }

    // The dialog asks twice and the browser checks the pair, but the same rule belongs on
    // this side: the account it is about to make is the one the password signs back in to.
    const mismatch = passwordConfirmationProblem(password, confirm);

    if (mismatch) {
      res.status(400).json({ error: mismatch, needsGuest: true });
      return;
    }

    if (!guestRequestAllowed(req.ip || req.socket.remoteAddress || 'unknown')) {
      res.status(429).json({
        error: 'That is a lot of requests from this connection. Try again in an hour.',
      });
      return;
    }

    try {
      // The password makes this an account, not a one-off: it is the pair the ordinary
      // email sign-in reads, so the person can come back and find their requests.
      const passwordHash = await hashPassword(password);
      user = await makeGuestPerson({ accountName, email, passwordHash });
      req.session.user = user;
      req.session.accountNames = null;
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
      return;
    }
  }

  const itemKind = req.body.kind === 'offer' ? 'offer' : 'inventory';
  const itemId = Number(req.body.id);
  const quantity = Number(req.body.quantity || 1);

  if (!Number.isFinite(itemId) || itemId <= 0) {
    res.status(400).json({ error: 'That request did not name an item.' });
    return;
  }

  try {
    const outcome = await withDatabase(async (connection) => {
      let accountNames = await viewerAccountNames(req, connection, user);
      // A person with nothing attached yet is asked for the account at the moment they
      // need it, and the name is attached to their sign-in as the request is made, so
      // this happens once. Refusing instead sent them off to upload a file first, which
      // is how you share - not how the site knows who is asking.

      if (accountNames.length === 0) {
        const typed = normalizeEsoAccountName(req.body && req.body.accountName);

        if (!typed) {
          const error = new Error(
            'Say which ESO account you play, so the owner knows who is asking.'
          );
          error.statusCode = 400;
          throw error;
        }

        const link = await linkAccountToUser(connection, { accountName: typed, userId: user.id });

        if (link === 'conflict') {
          const error = new Error(
            `${typed} is attached to another sign-in. Ask from the ESO account you play, or attach it from the avatar menu.`
          );
          error.statusCode = 409;
          throw error;
        }

        accountNames = [typed];
        // The session copy was read before the link existed.
        req.session.accountNames = null;
      }        // The list already shows only the chosen account's guilds; the request itself
        // has to be scoped the same way, and the chosen account is the recipient.
        const browsingAccount = browsingAccountFor(
          accountNames,
          await getBrowsingAccount(connection, user.id)
        );

        return createRequest(connection, {
          userId: user.id,
          requesterAccounts: browsingAccount ? [browsingAccount] : accountNames,
          ownAccounts: accountNames,
          requesterAccount: browsingAccount,
          itemKind,
          itemId,
          quantity,
          holdMinutes: HOLD_MINUTES,
          // An account without matching recorded guilds must upload before reserving.
          restrictToGuilds: true,
        });
    });

    // Everyone looking at that stack needs the new count straight away.
    notifyItemsChanged(
      'request',
      `${personLabel(user, outcome.requesterAccountName)} asked for ${outcome.quantity} x ${
        outcome.itemName
      } from ${outcome.ownerAccountName}`
    );
    res.json({ ok: true, ...outcome });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/requests/:id/cancel', async (req, res) => {
  const user = req.session ? req.session.user || null : null;

  if (!user) {
    res.status(401).json({ error: 'Sign in to change your requests.' });
    return;
  }

  try {
    const outcome = await withDatabase((connection) =>
      cancelOwnRequest(connection, {
        userId: user.id,
        requestId: Number(req.params.id),
        holdMinutes: HOLD_MINUTES,
      })
    );

    if (!outcome.cancelled) {
      res.status(outcome.sentAlready ? 409 : 404).json({
        error: outcome.sentAlready
          ? 'That request has already been sent, so it stays in your request history.'
          : 'That request is not waiting any more.',
      });
      return;
    }

    notifyItemsChanged(
      'request',
      `${personLabel(user, outcome.requesterAccountName)} ${
        outcome.wasDraft ? 'took back' : 'cancelled'
      } their request for ${outcome.itemName || 'an item'}`
    );
    res.json({ ok: true, ...outcome });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Sending the basket. Everything held turns into a real request at once, so the
// owner is asked in one go rather than once per row the person happened to click.
app.post('/requests/submit', async (req, res) => {
  const user = req.session ? req.session.user || null : null;

  if (!user) {
    res.status(401).json({ error: 'Sign in before sending a request.' });
    return;
  }

  try {
    const outcome = await withDatabase(async (connection) => {
      const names = await viewerAccountNames(req, connection, user);
      const selected = browsingAccountFor(names, await getBrowsingAccount(connection, user.id));
      await reconcileDraftBasket(connection, { userId: user.id, accountName: selected });
      const basketRows = await getBasketRows(connection, user.id);
      const live = basketRows.filter((row) => row.status === 'draft');
      const sent = await submitDrafts(connection, { userId: user.id });

      // Re-read the rows that really flipped: one that lapsed between the read and the
      // update was never sent, so it must not turn up in anyone's inbox.
      const submitted =
        live.length > 0
          ? await getSubmittedRequests(
              connection,
              user.id,
              live.map((row) => row.id)
            )
          : [];
      const contacts = await getOwnerContacts(
        connection,
        submitted.map((row) => row.owner_account_name)
      );

      return {
        sent,
        basket: await getDraftBasket(connection, user.id, HOLD_MINUTES),
        submitted,
        contacts: [...contacts.entries()],
      };
    });

    if (outcome.sent === 0) {
      res.status(409).json({
        error: 'Nothing was still waiting to be sent - the clock had already run out.',
        sent: outcome.sent,
        basket: outcome.basket,
      });
      return;
    }

    // Mail goes out after the database work, so a slow mail API never holds a
    // connection open or makes the request itself wait to be real.
    const mail = await emailOwners({
      user,
      submitted: outcome.submitted,
      contacts: new Map(outcome.contacts),
    });

    notifyItemsChanged(
      'request',
      `${personLabel(
        user,
        (outcome.submitted || []).map((row) => row.requester_account_name)
      )} sent ${outcome.sent} request${outcome.sent === 1 ? '' : 's'}${
        mail.sent > 0 ? ` and emailed ${mail.sent} owner${mail.sent === 1 ? '' : 's'}` : ''
      }`
    );
    res.json({ ok: true, sent: outcome.sent, basket: outcome.basket, emailed: mail.sent });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// ---------------------------------------------- the owner's own list of requests
// The answer form in the email, for somebody who is already signed in. Nobody should
// have to keep a month-old message to say they mailed a stack, and the page knows which
// accounts are theirs, so it does not need a token to know what it may answer.

/** `?answered=2-1` means two handed over and one cancelled; anything else is ignored. */
function readAnsweredCounts(value) {
  const match = /^(\d{1,3})-(\d{1,3})$/.exec(String(value || ''));

  return match ? { fulfilled: Number(match[1]), cancelled: Number(match[2]) } : null;
}

/**
 * The answer posted by the owner's own list: one number for one item, and a `group`
 * naming the oldest pending request for it, because that is the row the list put the
 * rest of that item's asks under. `action=none` is the Not fulfilled button, which is
 * the same form saved as 0.
 */
function readOwnerAnswer(body) {
  const fields = body || {};
  const anchorId = Number(String(fields.group ?? '').trim());
  const typed = String(fields.quantity ?? '').trim();

  if (!Number.isInteger(anchorId) || anchorId <= 0) {
    return {
      anchorId: 0,
      sent: 0,
      typed,
      error: 'That form had nothing to record. Reload the list and try again.',
    };
  }

  if (String(fields.action || '') === 'none') {
    return { anchorId, sent: 0, typed, error: '' };
  }

  if (!/^\d+$/.test(typed)) {
    return {
      anchorId,
      sent: 0,
      typed,
      error: 'That box needs a whole number: how many you sent, or 0 for none.',
    };
  }

  return { anchorId, sent: Number(typed), typed, error: '' };
}

function signedOutOwnerPage(req, res) {
  sendPage(req, res, 401, {
    heading: 'Sign in to see what is waiting on your items',
    message: 'Requests are aimed at a person\'s ESO accounts, so this page needs to know who you are.',
    details: 'Sign in from the header, then open this page again.',
    tone: 'notice',
  });
}

// The owner's list is one piece of markup with two front doors: a whole page for a
// bookmark or a direct visit, and a fragment for the modal over the item list. Asking for
// the fragment means "give me the card, not the page around it".
function wantsFragment(req) {
  return (
    String(req.get('x-itemshare-fragment') || '') === '1' ||
    String(req.query.fragment || '') === '1'
  );
}

// ---------------------------------------------------------------- guild codes
// A member hands out a code for one guild; somebody else types it and is given that
// guild. The membership is written to the account they browse as and marked with the code
// it came from, so the next upload - which replaces what the game reported - leaves it
// alone. Nothing is granted from the form: the guild is looked up among the person's own
// guilds, and the code is looked up in the table, before anything is written.

function signedOutGuildPage(req, res) {
  sendPage(req, res, 401, {
    heading: 'Sign in to use a guild code',
    message: 'A code decides which guilds somebody may see, so the site has to know who is asking.',
    details: 'Sign in from the header, then open this page again.',
    tone: 'notice',
  });
}

/** The guild a create form named, or null when the value is not that shape. */
function readGuildChoice(value) {
  const parts = String(value || '').split('|');

  if (parts.length !== 3) {
    return null;
  }

  const [guildId, platform, worldName] = parts.map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return '';
    }
  });

  const guild = Number(guildId);
  const onPlatform = Number(platform);

  if (!Number.isFinite(guild) || guild <= 0 || !Number.isFinite(onPlatform) || onPlatform <= 0) {
    return null;
  }

  if (!String(worldName || '').trim()) {
    return null;
  }

  return { guildId: guild, platform: onPlatform, worldName: String(worldName).slice(0, 64) };
}

/** The accounts and the guilds they belong to, which is what both pages are built from. */
async function guildsOf(connection, userId, { grantableOnly = false } = {}) {
  const accounts = await getViewerAccounts(connection, userId);

  return {
    accounts,
    guilds: await getViewerGuilds(
      connection,
      accounts.map((row) => row.eso_account_name),
      { grantableOnly }
    ),
  };
}

app.get('/guilds/codes', async (req, res) => {
  const user = req.session ? req.session.user || null : null;

  if (!user) {
    signedOutGuildPage(req, res);
    return;
  }

  try {
    const data = await withDatabase((connection) => codesPageData(connection, user.id));

    sendCodesPage(res, { user, data });
  } catch (error) {
    sendPage(req, res, 500, {
      heading: 'Your codes could not be loaded',
      message: 'Nothing was changed.',
      details: error.message,
      tone: 'error',
    });
  }
});

app.post('/guilds/codes', async (req, res) => {
  const user = req.session ? req.session.user || null : null;

  if (!user) {
    signedOutGuildPage(req, res);
    return;
  }

  const chosen = readGuildChoice(req.body && req.body.guild);

  if (!chosen) {
    sendPage(req, res, 400, {
      heading: 'Choose a guild for the code',
      message: 'A code is for one guild, on one server.',
      details: 'Pick one of your guilds from the list, then press Create code.',
      tone: 'error',
    });
    return;
  }

  try {
    const made = await withDatabase(async (connection) => {
      const mine = await findOwnGuild(connection, user.id, chosen);

      if (!mine) {
        return null;
      }

      const code = await createGuildCode(connection, { userId: user.id, guild: mine });

      return { code, data: await codesPageData(connection, user.id) };
    });

    if (!made.code) {
      sendPage(req, res, 403, {
        heading: 'That guild is not one of yours',
        message: 'A code can only be made for a guild one of your ESO accounts belongs to.',
        details: 'Nothing was changed. If you have just joined in game, upload a saved variables file and the guild will be there.',
        tone: 'error',
      });
      return;
    }

    // Answered directly rather than redirected, so the address stays the page the person
    // is already on: a code has no address of its own, and nothing to bookmark by mistake.
    // A reload therefore asks the browser to send the form again, which is a question the
    // person answers rather than a second code made behind their back.
    sendCodesPage(res, { user, data: made.data, made: made.code });
  } catch (error) {
    sendPage(req, res, 500, {
      heading: 'That code could not be made',
      message: 'Nothing was changed.',
      details: error.message,
      tone: 'error',
    });
  }
});

/**
 * The data behind the codes page: the guilds the person can invite to, and the codes they
 * have made. The page and every answer that redraws it read exactly this.
 */
async function codesPageData(connection, userId) {
  // Only the guilds the file reported: a guild a code opened is the account's extra slot,
  // and the person it was opened for cannot make a code from it for somebody else.
  const { accounts, guilds } = await guildsOf(connection, userId, { grantableOnly: true });

  return { accounts, guilds, codes: await listGuildCodes(connection, userId) };
}

/** The codes page, drawn from data this request has already read. */
function sendCodesPage(res, { user, data, made = '', done = '', notice = '', status = 200 }) {
  res
    .status(status)
    .type('html')
    .send(renderGuildCodesPage({ ...data, made, done, notice, user, providers: enabledProviders }));
}

app.get('/guilds/join', async (req, res) => {
  const user = req.session ? req.session.user || null : null;

  if (!user) {
    signedOutGuildPage(req, res);
    return;
  }

  try {
    const accounts = await withDatabase((connection) => getViewerAccounts(connection, user.id));

    res.type('html').send(renderJoinGuildPage({ user, providers: enabledProviders, accounts }));
  } catch (error) {
    sendPage(req, res, 500, {
      heading: 'That page could not be loaded',
      message: 'Nothing was changed.',
      details: error.message,
      tone: 'error',
    });
  }
});

app.post('/guilds/join', async (req, res) => {
  const user = req.session ? req.session.user || null : null;

  if (!user) {
    signedOutGuildPage(req, res);
    return;
  }

  const typed = normalizeGuildCode(req.body && req.body.code);

  const askAgain = (status, notice) => {
    res.status(status).type('html').send(
      renderJoinGuildPage({
        notice,
        code: typed,
        user,
        providers: enabledProviders,
      })
    );
  };

  if (!isGuildCode(typed)) {
    askAgain(400, 'A code is eight letters and numbers, like K7QM-3XPD. Dashes and spaces do not matter.');
    return;
  }

  // The account name is typed here only when the site does not know one yet. Asking at the
  // moment the code is entered is better than a page that says "attach an account first":
  // the code is already in hand, and what was typed is not thrown away.
  const typedAccount = normalizeEsoAccountName(req.body && req.body.accountName);

  try {
    const outcome = await withDatabase(async (connection) => {
      const known = await getViewerAccounts(connection, user.id);
      const accounts = known.map((row) => row.eso_account_name);

      if (accounts.length === 0) {
        if (!typedAccount) {
          return { status: 'need-account' };
        }

        // The code carries the platform and the server, so only the name is typed here.
        // Asking for the other two would be asking somebody to retype what the code in
        // their hand already says, and a wrong pair would attach the account to a guild it
        // can never see. An unknown code links nothing and is refused below.
        const codeRow = await findGuildCode(connection, typed);

        if (codeRow) {
          // Linking is what an upload does too, and it refuses an account already attached
          // to somebody else rather than moving it - the answer the accounts dialog gives.
          const linked = await linkAccountToUser(connection, {
            accountName: typedAccount,
            userId: user.id,
            platform: Number(codeRow.platform) || 0,
            worldName: String(codeRow.world_name || ''),
          });

          if (linked === 'conflict') {
            return { status: 'conflict', accountName: typedAccount };
          }

          req.session.accountNames = null;
          accounts.push(typedAccount);
        }
      }

      return redeemGuildCode(connection, {
        userId: user.id,
        code: typed,
        accounts,
        accountName: typedAccount || (await getBrowsingAccount(connection, user.id)),
      });
    });

    if (outcome.status === 'joined') {
      notifyItemsChanged('guild', `${user.username || 'Someone'} joined a guild with a code`);

      sendPage(req, res, 200, {
        heading: `You are in ${outcome.guildName || 'that guild'}`,
        message: `${outcome.accountName} now belongs to ${
          outcome.guildName || 'that guild'
        }${outcome.worldName ? ` on ${outcome.worldName}` : ''}, so what it shares is in your list.`,
        details:
          'The next upload keeps it: a membership that came from a code is not replaced by what your saved variables file reports.',
        tone: 'notice',
      });
      return;
    }

    if (outcome.status === 'already') {
      sendPage(req, res, 200, {
        heading: `You are already in ${outcome.guildName || 'that guild'}`,
        message: 'One of your accounts already belongs to it, so its items are already in your list.',
        details: 'Nothing was changed.',
        tone: 'notice',
      });
      return;
    }

    // No account on file: the code is kept and the page asks whose account it is, in a box
    // over the top of it, rather than sending the person away to find one.
    if (outcome.status === 'need-account') {
      res.status(400).type('html').send(
        renderJoinGuildPage({
          needAccount: true,
          servers: outcome.servers,
          code: typed,
          user,
          providers: enabledProviders,
          notice:
            outcome.status === 'need-server'
              ? 'Choose the platform and server that account plays on.'
              : '',
        })
      );
      return;
    }

    if (outcome.status === 'conflict') {
      sendPage(req, res, 409, {
        heading: 'That ESO account is already taken',
        message: `${outcome.accountName} is attached to another sign-in.`,
        details:
          'If it is yours and you cannot get into that sign-in, the site owner can move it for you. Nothing was changed.',
        tone: 'error',
      });
      return;
    }

    askAgain(404, 'That code is not one this site made. Check it with the person who invited you.');
  } catch (error) {
    sendPage(req, res, 500, {
      heading: 'That code could not be used',
      message: 'Nothing was changed.',
      details: error.message,
      tone: 'error',
    });
  }
});

app.get('/owner/requests', async (req, res) => {
  const user = req.session ? req.session.user || null : null;

  if (!user) {
    signedOutOwnerPage(req, res);
    return;
  }

  try {
    const data = await withDatabase(async (connection) => {
      const accounts = await getViewerAccounts(connection, user.id);

      return {
        accounts,
        requests: await getOwnerRequests(
          connection,
          accounts.map((row) => row.eso_account_name)
        ),
      };
    });

    const answered = readAnsweredCounts(req.query.answered);

    if (wantsFragment(req)) {
      res.type('html').send(renderOwnerRequestsCard({ rows: data.requests, answered }));
      return;
    }

    res.type('html').send(
      renderOwnerRequestsPage({
        accounts: data.accounts,
        rows: data.requests,
        answered,
        user,
        providers: enabledProviders,
      })
    );
  } catch (error) {
    sendPage(req, res, 500, {
      heading: 'My Requests could not be loaded',
      message: error.message,
      details: 'Nothing was changed. Try again in a moment.',
      tone: 'error',
    });
  }
});

// `upload.none()` parses a multipart body without accepting files. The page posts
// urlencoded, which express.urlencoded already reads, but a browser still holding an older
// app.js posts FormData - and reading that as an empty form told somebody their answer had
// "nothing to record" when the row was filled in right in front of them.
app.post('/owner/requests', upload.none(), async (req, res) => {
  const user = req.session ? req.session.user || null : null;

  if (!user) {
    signedOutOwnerPage(req, res);
    return;
  }

  const answer = readOwnerAnswer(req.body);
  const invalid = answer.error;

  // The list is reloaded for every outcome, because an answer changes what is in it.
  const renderList = async (status, notice, answered = null) => {
    const data = await withDatabase(async (connection) => {
      const accounts = await getViewerAccounts(connection, user.id);

      return {
        accounts,
        requests: await getOwnerRequests(
          connection,
          accounts.map((row) => row.eso_account_name)
        ),
      };
    });

    const values = answer.anchorId > 0 ? new Map([[answer.anchorId, answer.typed]]) : new Map();

    // The modal gets the card and a 200 even when the answer was refused: the refused
    // number and the reason for it belong beside that row on screen, not in a toast that
    // leaves the old list standing.
    if (wantsFragment(req)) {
      res
        .status(200)
        .type('html')
        .send(renderOwnerRequestsCard({ rows: data.requests, notice, answered, values }));
      return;
    }

    res.status(status).type('html').send(
      renderOwnerRequestsPage({
        accounts: data.accounts,
        rows: data.requests,
        notice,
        answered,
        values,
        user,
        providers: enabledProviders,
      })
    );
  };

  if (invalid) {
    try {
      await renderList(400, invalid);
    } catch (error) {
      sendPage(req, res, 500, {
        heading: 'That could not be recorded',
        message: error.message,
        details: 'Nothing was changed. Try again in a moment.',
        tone: 'error',
      });
    }
    return;
  }

  try {
    const outcome = await withDatabase(async (connection) => {
      const accounts = await getViewerAccounts(connection, user.id);

      return recordOwnerGroupAnswer(connection, {
        accountNames: accounts.map((row) => row.eso_account_name),
        anchorId: answer.anchorId,
        sent: answer.sent,
      });
    });

    if (outcome.fulfilled + outcome.cancelled > 0) {
      notifyItemsChanged(
        'request',
        `A request was answered: ${outcome.copies} cop${
          outcome.copies === 1 ? 'y' : 'ies'
        } handed over, ${outcome.cancelled} cancelled`
      );
    }

    // The person who asked hears about it too: the copies are waiting in their in-game
    // mailbox and nothing in the game says so.
    await emailAnswered(outcome.rows, {
      demo: Boolean(req.session && req.session.user && req.session.user.isDemo),
    });

    if (wantsFragment(req)) {
      // The whole outcome, not just the counts: the card's confirmation names the item,
      // the copies and the requester, and the row it came from is about to disappear.
      await renderList(200, '', outcome);
      return;
    }

    // Post, then redirect: a refresh shows the page again instead of answering again,
    // and the rows that were answered are simply gone from the list.
    res.redirect(303, `/owner/requests?answered=${outcome.fulfilled}-${outcome.cancelled}`);
  } catch (error) {
    sendPage(req, res, 500, {
      heading: 'That could not be recorded',
      message: error.message,
      details: 'Nothing was changed. Try again in a moment.',
      tone: 'error',
    });
  }
});

// ------------------------------------------ answering a request from email
// The token in the address is the credential: an owner reading mail on a phone is not
// going to sign in first. It is single use, it expires, and it only names the rows of
// that one message - so the worst a forwarded link can do is answer those rows, once.
//
// GET shows the form (and is what the fallback link in the message opens); POST records
// it. A form that acted on GET would be answered by any mail client that prefetches
// links, before the owner had read the message.
const EMAIL_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

/**
 * The numbers from a submitted answer form, keyed by request id.
 *
 * Each row posts on its own - a `row` field naming the request and one `quantity` -
 * because a message is rarely answered in one go, and a single button for eight rows
 * made a partial answer look like a decision about all of them. Fields named
 * `quantity_<id>` are still read, so a page left open from before that change works.
 * Whole numbers only, and a row the form did not carry is not guessed at.
 */
function readSentQuantities(body) {
  const fields = body || {};
  const sent = new Map();
  const entries = [];

  if (fields.row !== undefined) {
    entries.push([fields.quantity, Number(String(fields.row).trim())]);
  } else {
    for (const [name, value] of Object.entries(fields)) {
      const match = /^quantity_(\d+)$/.exec(name);

      if (match) {
        entries.push([value, Number(match[1])]);
      }
    }
  }

  if (entries.length === 0) {
    return { sent, error: 'That form had nothing to record. Open the link from the email again.' };
  }

  for (const [value, id] of entries) {
    const raw = String(value ?? '').trim();

    if (!/^\d+$/.test(raw) || !Number.isInteger(id) || id <= 0) {
      return { sent, error: 'That box needs a whole number: how many you sent, or 0 for none.' };
    }

    sent.set(id, Number(raw));
  }

  return { sent, error: '' };
}

function sendAnsweredAlready(req, res) {
  sendPage(req, res, 410, {
    heading: 'That request has already been answered',
    message: 'The link has been used, the request was cancelled, or the form has expired.',
    details: 'Nothing was changed. Use the newest request email, or sign in on the site.',
  });
}

app.get('/requests/fulfill/:token', async (req, res) => {
  const token = String(req.params.token || '');
  // The token is in the address bar, so this page must not hand it on in a Referer
  // header to anything it links to.
  res.set('Referrer-Policy', 'no-referrer');

  if (!EMAIL_TOKEN_PATTERN.test(token)) {
    sendPage(req, res, 404, {
      heading: 'That link is not a request form',
      message: 'The address is incomplete, so there is nothing here to answer.',
      details: 'Open the link from the request email again, or sign in on the site to see your own list.',
      tone: 'error',
    });
    return;
  }

  try {
    const form = await withDatabase((connection) => getFulfillForm(connection, token));

    if (!form) {
      sendAnsweredAlready(req, res);
      return;
    }

    res.type('html').send(
      renderRequestFulfillPage({
        token,
        rows: form.rows,
        user: req.session ? req.session.user || null : null,
        providers: enabledProviders,
      })
    );
  } catch (error) {
    sendPage(req, res, 500, {
      heading: 'The form could not be loaded',
      message: error.message,
      details: 'Nothing was changed. Try the link again in a moment.',
      tone: 'error',
    });
  }
});

app.post('/requests/fulfill/:token', async (req, res) => {
  const token = String(req.params.token || '');
  res.set('Referrer-Policy', 'no-referrer');

  if (!EMAIL_TOKEN_PATTERN.test(token)) {
    sendPage(req, res, 404, {
      heading: 'That link is not a request form',
      message: 'The address is incomplete, so there is nothing here to answer.',
      details: 'Open the link from the request email again.',
      tone: 'error',
    });
    return;
  }

  const { sent, error: invalid } = readSentQuantities(req.body);

  if (invalid) {
    // Show the form again with what they typed: retyping a screen of numbers because one
    // box held a letter is the sort of thing that makes people give up on the site.
    try {
      const form = await withDatabase((connection) => getFulfillForm(connection, token));

      if (!form) {
        sendAnsweredAlready(req, res);
        return;
      }

      res.status(400).type('html').send(
        renderRequestFulfillPage({
          token,
          rows: form.rows,
          notice: invalid,
          values: sent,
          user: req.session ? req.session.user || null : null,
          providers: enabledProviders,
        })
      );
    } catch (error) {
      sendPage(req, res, 500, {
        heading: 'The form could not be loaded',
        message: error.message,
        details: 'Nothing was changed. Try again in a moment.',
        tone: 'error',
      });
    }
    return;
  }

  try {
    const outcome = await withDatabase((connection) =>
      recordFulfillment(connection, { token, sentById: sent })
    );

    if (!outcome) {
      sendAnsweredAlready(req, res);
      return;
    }

    const summary = outcome.rows
      .map((row) =>
        row.status === 'fulfilled'
          ? `${row.sent}${row.sent === row.asked ? '' : ` of ${row.asked}`} x ${
              row.itemName || 'item'
            } recorded as sent`
          : `${row.itemName || 'An item'} marked as nothing sent`
      )
      .join('; ');

    if (outcome.fulfilled + outcome.cancelled > 0) {
      notifyItemsChanged(
        'request',
        `A request was answered: ${outcome.copies} cop${
          outcome.copies === 1 ? 'y' : 'ies'
        } handed over, ${outcome.cancelled} cancelled`
      );
    }

    await emailAnswered(outcome.rows, {
      demo: Boolean(req.session && req.session.user && req.session.user.isDemo),
    });

    res.type('html').send(
      renderMessagePage({
        title: 'Request answered - ItemShare',
        heading: 'Thanks - that is recorded',
        message: summary ? `${summary}.` : 'Nothing was waiting on that link any more.',
        details:
          'The shared counts are updated, and the person who asked can see what became of their request.',
        user: req.session ? req.session.user || null : null,
        providers: enabledProviders,
      })
    );
  } catch (error) {
    sendPage(req, res, 500, {
      heading: 'That could not be recorded',
      message: error.message,
      details: 'Nothing was changed. Try again in a moment.',
      tone: 'error',
    });
  }
});

// Icons were fetched from UESP once, at upload time, and live in MariaDB now.
// Long lived caching headers keep repeat views off the database too.
app.get('/icons/:file', async (req, res) => {
  const match = String(req.params.file || '').match(/^([a-f0-9]{40})\.png$/);

  if (!match) {
    res.status(404).end();
    return;
  }

  try {
    const icon = await withDatabase((connection) => getCachedIcon(connection, match[1]));

    if (!icon) {
      res.status(404).end();
      return;
    }

    res.set('Content-Type', icon.content_type || 'image/png');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(icon.image_data);
  } catch (error) {
    warnLine(`Could not serve icon ${match[1]}: ${error.message}`);
    res.status(500).end();
  }
});

// The second half of an item's hover card: the game's description of it and what its
// set does. UESP answers both publicly, and lib/uesp.js keeps the answer in MariaDB
// for a month, so this is a cache read almost every time.
app.get('/item-tip', async (req, res) => {
  const itemId = Number(req.query.item) || 0;
  const setName = String(req.query.set || '').trim().slice(0, 120);

  res.set('Cache-Control', 'private, max-age=600');

  if (itemId <= 0 && !setName) {
    res.status(400).json({ error: 'Name an item or a set to look up.' });
    return;
  }

  try {
    res.json(await withDatabase((connection) => getItemTip(connection, { itemId, setName })));
  } catch (error) {
    // A tooltip is never worth an error page: the card keeps what the row already
    // carries and simply says nothing more.
    res.status(200).json({ available: false, error: error.message });
  }
});

app.get('/auth/:provider', (req, res) => {
  const provider = PROVIDERS[req.params.provider];

  if (!provider || !provider.configured) {
    sendPage(req, res, 503, {
      heading: 'That sign-in option is not set up',
      message: 'This site has no client configured for that provider yet, so there is nothing to sign in with.',
      details: 'Set the provider client id and secret in .env and restart the site.',
    });
    return;
  }

  const params = new URLSearchParams({
    client_id: provider.clientId,
    redirect_uri: provider.redirectUri,
    response_type: 'code',
    scope: provider.scope,
    state: req.sessionID,
  });

  if (provider.key === 'google') {
    params.set('prompt', 'select_account');
  }

  res.redirect(`${provider.authorizeUrl}?${params.toString()}`);
});

app.get('/auth/:provider/callback', async (req, res) => {
  const provider = PROVIDERS[req.params.provider];
  const { code, error } = req.query;

  if (!provider || !provider.configured) {
    sendPage(req, res, 503, {
      heading: 'That sign-in option is not set up',
      message: 'This site has no client configured for that provider yet, so there is nothing to sign in with.',
      details: 'Set the provider client id and secret in .env and restart the site.',
    });
    return;
  }
  if (error || !code) {
    sendPage(req, res, 400, {
      heading: `${provider.label} sign-in did not finish`,
      message: error
        ? 'The provider sent us back without permission, or the prompt was cancelled.'
        : 'The provider sent us back without a code, so there was nothing to verify.',
      details: 'Nothing was changed. You can try again from the header.',
      tone: 'error',
    });
    return;
  }

  try {
    const tokenResponse = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: provider.redirectUri,
      }),
    });

    const token = await tokenResponse.json().catch(() => ({}));

    if (!tokenResponse.ok || !token.access_token) {
      throw new Error(`${provider.label} token exchange failed (${tokenResponse.status})`);
    }

    const userResponse = await fetch(provider.profileUrl, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });

    if (!userResponse.ok) {
      throw new Error(`${provider.label} profile lookup failed (${userResponse.status})`);
    }

    const profile = await userResponse.json();
    const identity = provider.readProfile(profile);

    const signedIn = await withDatabase((connection) =>
      signInWithProvider(connection, { provider: provider.key, ...identity })
    );

    req.session.user = {
      id: signedIn.userId,
      provider: provider.key,
      providerLabel: provider.label,
      username: identity.username,
      email: identity.email,
      emailVerified: identity.emailVerified,
      // Discarded by the store if it is not https, so whatever is left is safe to
      // put in an img src.
      avatarUrl: signedIn.avatarUrl || identity.avatarUrl || '',
    };
    req.session.accountNames = null;

    res.redirect('/');
  } catch (caught) {
    sendPage(req, res, 502, {
      heading: 'Sign-in could not be completed',
      message: 'The provider accepted the request, but the account could not be looked up or saved.',
      details: caught.message,
      tone: 'error',
    });
  }
});

// ---------------------------------------------------------- email and password
//
// Signing in needed a Discord or Google account, which left anybody with neither of them
// outside the site. These two forms are the way in that needs nothing configured: one
// signs in with an address and a password, the other makes the pair. The address is not
// a username - it is where the note goes when somebody answers a request - which is why
// the page says so before asking for it.

// A wrong password and an address nobody uses must cost the same, or the form can be
// used to find out which addresses have accounts here. This is a real hash of a password
// nobody has, made once and then reused.
let decoyHash = null;
function decoyPasswordHash() {
  if (!decoyHash) {
    decoyHash = hashPassword('a password that is never anybody\u2019s');
  }
  return decoyHash;
}

function startPersonSession(req, { id, provider, providerLabel, username, email, isDemo = false }) {
  req.session.user = {
    id,
    provider,
    providerLabel,
    username,
    email,
    // Written into the session once, at sign-in, and never from a form: it is what turns
    // every write away below. A cookie cannot add it, because the session is signed.
    isDemo: Boolean(isDemo),
    // An address typed into a form is unverified: the site has no proof anybody can read
    // mail there, and saying otherwise would let it join an existing person's account.
    emailVerified: false,
    avatarUrl: '',
  };
  // Which ESO accounts are theirs is read from the database on the next request, so a
  // session copy written before this sign-in can never decide who they are.
  req.session.accountNames = null;
}

app.post('/auth/email', async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  const password = String((req.body && req.body.password) || '');

  // The demo address is answered here, before the ordinary lookup: the demo person lives
  // in the demo database, so the real one is never opened on its behalf.
  if (email === DEMO_LOGIN) {
    try {
      // The demo person is looked up in the demo database, where it is created if it is
      // missing: a sign-in must never write rows into the real one.
      const login = await withDatabaseOn(DEMO_DATABASE, async (connection) => {
        await ensureDemoData(connection);
        // Somebody arriving finds the shelves as full as the catalogues allow, whatever
        // the last visitor's session or the activity loop left behind. Debounced, so
        // signing in twice does not write them twice.
        await keepDemoShelfFull(connection);
        return findDemoSignIn(connection);
      });
      // The same decoy hash the ordinary form uses, so a wrong demo password costs the
      // same as a wrong password anywhere else.
      const matches = await verifyPassword(
        password,
        login ? login.passwordHash : await decoyPasswordHash()
      );

      if (!login || !matches) {
        sendPage(req, res, 401, {
          heading: 'That demo password does not match',
          message: 'The demo signs in with demo@example.com and the password demo.',
          tone: 'error',
        });
        return;
      }

      startPersonSession(req, {
        id: login.userId,
        provider: 'password',
        providerLabel: 'demo',
        username: DEMO_DISPLAY_NAME,
        email: '',
        isDemo: true,
      });
      res.redirect(303, '/');
    } catch (error) {
      sendPage(req, res, 500, {
        heading: 'The demo could not be opened',
        message: 'Nothing was changed. Try again in a moment.',
        details: error.message,
        tone: 'error',
      });
    }
    return;
  }

  if (!emailLooksValid(email) || password.length === 0) {
    sendPage(req, res, 400, {
      heading: 'That sign-in did not work',
      message: 'Type the email address and the password you signed up with.',
      tone: 'error',
    });
    return;
  }

  try {
    const login = await withDatabase((connection) => findPasswordLogin(connection, email));
    const matches = await verifyPassword(
      password,
      login ? login.passwordHash : await decoyPasswordHash()
    );

    if (!login || !matches) {
      sendPage(req, res, 401, {
        heading: 'That email and password do not match',
        message: 'Check both and try again.',
        details: 'If you have never signed in here with a password, create an account from the sign-in page.',
        tone: 'error',
      });
      return;
    }

    await withDatabase((connection) => notePasswordUsed(connection, login.userId));
    startPersonSession(req, {
      id: login.userId,
      provider: 'password',
      providerLabel: 'email',
      username: login.displayName || login.email,
      email: login.email,
    });
    res.redirect(303, '/');
  } catch (error) {
    sendPage(req, res, 500, {
      heading: 'Sign-in could not be completed',
      message: 'The site could not read the account just now. Nothing was changed.',
      details: error.message,
      tone: 'error',
    });
  }
});

app.post('/auth/email/signup', async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  const password = String((req.body && req.body.password) || '');
  // The second box the form asks for. It is read here as well as in the browser, because
  // a form posts whether or not a script ever ran.
  const confirm = String((req.body && req.body.confirm) || '');

  // The demo address is reserved. An ordinary account created with it would be answered
  // by the demo branch on every sign-in, so the form refuses it instead of making one.
  if (email === DEMO_LOGIN) {
    sendPage(req, res, 400, {
      heading: 'That address is the demo',
      message:
        'demo@example.com is the demo sign-in, with the password demo. Create an account with your own address instead.',
      tone: 'notice',
    });
    return;
  }

  if (!emailLooksValid(email)) {
    sendPage(req, res, 400, {
      heading: 'That email address does not look right',
      message: 'Check the address and try again.',
      tone: 'error',
    });
    return;
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    sendPage(req, res, 400, {
      heading: 'That password is too short',
      message: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
      tone: 'error',
    });
    return;
  }

  // Checked before the hash, so a pair that disagrees costs nothing and is answered as
  // the typo it is rather than as an account that could not be made.
  const mismatch = passwordConfirmationProblem(password, confirm);

  if (mismatch) {
    sendPage(req, res, 400, {
      heading: 'Those two passwords are not the same',
      message: mismatch,
      tone: 'error',
    });
    return;
  }

  try {
    const passwordHash = await hashPassword(password);
    // The name in the header is the part of the address before the @: the address itself
    // is the one thing on the page that other people must never be shown.
    const displayName = email.split('@')[0].slice(0, 96);
    const created = await withDatabase((connection) =>
      createPasswordAccount(connection, { email, passwordHash, displayName })
    );

    if (!created.created) {
      sendPage(req, res, 409, {
        heading: 'That email already has an account',
        message: 'Sign in with the password you chose, or with the sign-in you used before.',
        tone: 'error',
      });
      return;
    }

    startPersonSession(req, {
      id: created.userId,
      provider: 'password',
      providerLabel: 'email',
      username: displayName,
      email,
    });
    res.redirect(303, '/');
  } catch (error) {
    sendPage(req, res, 500, {
      heading: 'That account could not be made',
      message: 'Nothing was saved. Try again in a moment.',
      details: error.message,
      tone: 'error',
    });
  }
});

// --------------------------------------------------------- forgotten passwords
//
// The way back in when the password is gone: a link by mail, one use, thirty minutes.
//
// The form answers the same thing whether or not the address has an account here,
// because a form that answers differently is a way of finding out which addresses are
// registered. The same reason keeps the mail itself plain: one link and how long it
// lasts. `RESET_PER_HOUR` bounds the mail one connection can cause, in memory, the same
// way the guest window above does.
const RESET_PER_HOUR = 5;
const RESET_WINDOW_MS = 60 * 60 * 1000;
const resetWindows = new Map();
const RESET_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function resetRequestAllowed(key, now = Date.now()) {
  const cutoff = now - RESET_WINDOW_MS;
  const hits = (resetWindows.get(key) || []).filter((at) => at > cutoff);

  if (hits.length >= RESET_PER_HOUR) {
    resetWindows.set(key, hits);
    return false;
  }

  hits.push(now);
  resetWindows.set(key, hits);

  if (resetWindows.size > 5000) {
    for (const [entry, times] of resetWindows) {
      if (times.every((at) => at <= cutoff)) {
        resetWindows.delete(entry);
      }
    }
  }

  return true;
}

app.get('/auth/email/forgot', (req, res) => {
  res.type('html').send(
    renderForgotPasswordPage({
      user: req.session ? req.session.user || null : null,
      providers: enabledProviders,
    })
  );
});

app.post('/auth/email/forgot', async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);

  if (!emailLooksValid(email)) {
    res.status(400).type('html').send(
      renderForgotPasswordPage({
        user: req.session ? req.session.user || null : null,
        providers: enabledProviders,
        notice: 'That does not look like an email address.',
      })
    );
    return;
  }

  if (!resetRequestAllowed(req.ip || req.socket.remoteAddress || 'unknown')) {
    sendPage(req, res, 429, {
      heading: 'That is a lot of reset links',
      message: 'Try again in an hour.',
      tone: 'error',
    });
    return;
  }

  try {
    const reset = await withDatabase((connection) => createPasswordReset(connection, email));

    if (reset) {
      const config = emailConfig();
      const resetUrl = config.siteUrl
        ? `${config.siteUrl}/auth/email/reset/${reset.token}`
        : `/auth/email/reset/${reset.token}`;

      if (!config.siteUrl) {
        warnLine(
          'Email: BASE_URL is not set, so the reset link in the message is relative and will not work from a mail client'
        );
      }

      const message = renderPasswordResetEmail({
        resetUrl,
        siteUrl: config.siteUrl,
        expiresMinutes: RESET_TOKEN_MINUTES,
        displayName: reset.displayName,
      });

      const result = await sendEmail({ to: reset.email || email, ...message }, config);

      if (!result.ok) {
        warnLine(`Email: could not send a reset link: ${result.error}`);
      }
    }

    sendPage(req, res, 200, {
      heading: 'Check your email',
      message: 'If that address has an account here, a link to choose a new password is on its way.',
      details: `The link works once and expires in ${RESET_TOKEN_MINUTES} minutes. Nothing changes until it is used.`,
    });
  } catch (error) {
    sendPage(req, res, 500, {
      heading: 'That link could not be sent',
      message: 'Nothing was changed. Try again in a moment.',
      details: error.message,
      tone: 'error',
    });
  }
});

app.get('/auth/email/reset/:token', (req, res) => {
  const token = String(req.params.token || '');
  // The token is in the address bar, so this page must not hand it on in a Referer.
  res.set('Referrer-Policy', 'no-referrer');

  if (!RESET_TOKEN_PATTERN.test(token)) {
    sendPage(req, res, 404, {
      heading: 'That link is not a reset link',
      message: 'The address is incomplete, so there is no password to change here.',
      details: 'Ask for a new link from the sign-in page.',
      tone: 'error',
    });
    return;
  }

  res.type('html').send(
    renderResetPasswordPage({
      token,
      user: req.session ? req.session.user || null : null,
      providers: enabledProviders,
    })
  );
});

app.post('/auth/email/reset/:token', async (req, res) => {
  const token = String(req.params.token || '');
  res.set('Referrer-Policy', 'no-referrer');

  const password = String((req.body && req.body.password) || '');
  const confirm = String((req.body && req.body.confirm) || '');

  const again = (notice) =>
    res.status(400).type('html').send(
      renderResetPasswordPage({
        token,
        user: req.session ? req.session.user || null : null,
        providers: enabledProviders,
        notice,
      })
    );

  if (!RESET_TOKEN_PATTERN.test(token)) {
    sendPage(req, res, 404, {
      heading: 'That link is not a reset link',
      message: 'The address is incomplete, so there is no password to change here.',
      details: 'Ask for a new link from the sign-in page.',
      tone: 'error',
    });
    return;
  }

  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    again(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
    return;
  }

  if (password !== confirm) {
    again('The two entries did not match. Nothing was changed.');
    return;
  }

  try {
    const passwordHash = await hashPassword(password);
    const done = await withDatabase((connection) =>
      consumePasswordReset(connection, token, passwordHash)
    );

    if (!done) {
      sendPage(req, res, 410, {
        heading: 'That link has expired',
        message: 'It has already been used, or it is older than its thirty minutes.',
        details: 'Ask for a new link from the sign-in page.',
        tone: 'error',
      });
      return;
    }

    // The link proved the address and chose the password, so this is a sign-in: making
    // them type the pair they just picked would be a step with nothing in it.
    startPersonSession(req, {
      id: done.userId,
      provider: 'password',
      providerLabel: 'email',
      username: done.displayName || done.email,
      email: done.email,
    });
    res.redirect(303, '/');
  } catch (error) {
    sendPage(req, res, 500, {
      heading: 'That password could not be changed',
      message: 'Nothing was changed. Try the link again in a moment.',
      details: error.message,
      tone: 'error',
    });
  }
});

// --------------------------------------------------------------- ESO accounts
//
// Which ESO accounts belong to this sign-in. The addon tells the site this by upload,
// but the site needs the answer before anybody uploads - it is what makes a name a
// person, and what a request is addressed from - so the same link can be made by hand
// here and unmade again.

app.post('/accounts/add', async (req, res) => {
  const user = req.session ? req.session.user || null : null;

  if (!user) {
    res.redirect(303, '/');
    return;
  }

  // Typed by hand, so it is made the shape the addon writes: lower case, one @ in front,
  // no spaces. The addon and the box have to agree or the same account is two accounts.
  const accountName = normalizeEsoAccountName(req.body && req.body.accountName);
  const where = readAccountServer(req.body);

  if (!accountName) {
    sendPage(req, res, 400, {
      heading: 'That is not an account name',
      message: 'Type the ESO account name, for example @YourAccountName.',
      details: 'Lower case, with an @ in front - the site adds the @ if you leave it out.',
      tone: 'error',
    });
    return;
  }

  // Both are required, not optional extras: the same @handle and guild id exist on every
  // platform and megaserver, so a name without them names nothing a request can be sent to.
  if (!where) {
    sendPage(req, res, 400, {
      heading: 'Say which platform and server',
      message: 'An ESO account only means something on the platform and megaserver it plays on.',
      details: 'Choose both from the list - a request cannot tell NA from EU without them.',
      tone: 'error',
    });
    return;
  }

  try {
    const outcome = await withDatabase((connection) =>
      linkAccountToUser(connection, { accountName, userId: user.id, ...where })
    );

    if (outcome === 'conflict') {
      sendPage(req, res, 409, {
        heading: 'That account is already taken',
        message: `${accountName} is attached to another sign-in.`,
        details: 'If it is yours and you cannot get into that sign-in, the site owner can move it for you.',
        tone: 'error',
      });
      return;
    }

    req.session.accountNames = null;
    res.redirect(303, '/');
  } catch (error) {
    sendPage(req, res, 500, {
      heading: 'That account could not be attached',
      message: 'Nothing was changed.',
      details: error.message,
      tone: 'error',
    });
  }
});

app.post('/accounts/remove', async (req, res) => {
  const user = req.session ? req.session.user || null : null;

  if (!user) {
    res.redirect(303, '/');
    return;
  }

  const accountName = String((req.body && req.body.accountName) || '').trim();

  try {
    // Ownership is the condition of the update itself, so a name from the form can never
    // unlink somebody else's account.
    const outcome = await withDatabase(async (connection) => {
      const removed = await detachAccountFromUser(connection, { userId: user.id, accountName });

      if (!removed) {
        return { removed: false, restored: false };
      }

      // The demo's own account goes straight back: it is what the demo browses and asks
      // as, and a demo with no account is a demo that cannot do anything. Attached again
      // in the same request, so a page never sees the gap.
      if (demoRemovalRestores(user, accountName)) {
        await linkAccountToUser(connection, { accountName: DEMO_ACCOUNT, userId: user.id });
        return { removed: true, restored: true };
      }

      return { removed: true, restored: false };
    });

    if (!outcome.removed) {
      sendPage(req, res, 404, {
        heading: 'That account is not attached to you',
        message: 'Nothing was changed.',
        tone: 'error',
      });
      return;
    }

    req.session.accountNames = null;

    if (outcome.restored) {
      sendPage(req, res, 200, {
        heading: 'The demo account stays attached',
        message: `${DEMO_ACCOUNT} is the account the demo browses and asks as, so it was attached again straight away.`,
        details:
          'Removing any other account really removes it. This one is put back so the demo always has something to request from.',
        tone: 'notice',
      });
      return;
    }

    res.redirect(303, '/');
  } catch (error) {
    sendPage(req, res, 500, {
      heading: 'That account could not be removed',
      message: 'Nothing was changed.',
      details: error.message,
      tone: 'error',
    });
  }
});

// Log out is the only way to end a session that is not cookie expiry, so it has to
// actually delete the row as well as the cookie: leaving either behind means the
// next request walks straight back in.
app.post('/logout', (req, res) => {
  const finish = () => {
    res.clearCookie('connect.sid');
    res.redirect('/');
  };

  if (req.session) {
    req.session.destroy(() => finish());
    return;
  }

  finish();
});

// ---------------------------------------------------------------- applying a file
//
// What happens to a saved variables file once it is in hand - whether it arrived
// through the page as a multipart upload or from GuildSync watching the file on the
// machine that runs the game. Both routes hand over the text and get the same
// summary back, so the two can never drift apart.
async function applySavedVariablesUpload({ fileText, sourceFile, user }) {
  let parsed;

  try {
    parsed = extractShareData(fileText);
  } catch (error) {
    const invalid = new Error(`Could not read that file: ${error.message}`);
    invalid.statusCode = 400;
    throw invalid;
  }

  if (parsed.accounts.length === 0) {
    const empty = new Error(
      'No ESO account was found in that file. Upload ItemShareSavedVars.lua, not another file.'
    );
    empty.statusCode = 400;
    throw empty;
  }

  // Icons are resolved before the replace and outside its transaction: the
  // database may already know the path from an earlier upload, and anything it
  // does not is looked up once by item id on UESP. Holding the replace open
  // across those requests would be wrong, and an icon is never worth failing an
  // upload over.
  const iconEntries = [...parsed.items, ...parsed.alwaysShare];

  try {
    await withDatabase((connection) => fillKnownIcons(connection, iconEntries));
  } catch (error) {
    warnLine(`Could not reuse stored icon paths: ${error.message}`);
  }

  let iconLookup = { resolved: 0, attempted: 0, missing: 0 };

  try {
    iconLookup = await resolveMissingIconPaths(iconEntries);

    if (iconLookup.attempted) {
      logLine(
        `Icons: resolved ${iconLookup.resolved} of ${iconLookup.missing} missing paths on UESP`
      );
    }
  } catch (error) {
    warnLine(`Could not look up icon paths on UESP: ${error.message}`);
  }

  // ESO accounts in the file that belong to somebody else, so they are not part of this
  // upload. Filled in while the accounts are checked.
  const skippedAccounts = [];

  const outcome = await withDatabase(async (connection) => {
    let usableAccounts = parsed.accounts;

    if (user) {
      // An ESO account already linked to somebody else is left alone rather than failing
      // the whole file: a shared computer, or a saved variables file copied from another
      // player, usually still holds the uploader's own account, and refusing the lot threw
      // that away over an account they were never going to get. The rest is stored, and the
      // answer says which names were skipped and why.
      usableAccounts = [];

      for (const accountName of parsed.accounts) {
        const link = await linkAccountToUser(connection, { accountName, userId: user.id });

        if (link === 'conflict') {
          skippedAccounts.push({
            accountName,
            reason: 'already linked to a different person',
          });
          continue;
        }

        usableAccounts.push(accountName);
      }

      if (usableAccounts.length === 0) {
        // Nothing is left to store, so say that plainly instead of reporting a successful
        // upload that changed nothing.
        const refused = new Error(
          parsed.accounts.length === 1
            ? `The ESO account ${parsed.accounts[0]} is already linked to a different person, so that file could not be used. Nothing was stored.`
            : `Every ESO account in that file (${parsed.accounts.join(
                ', '
              )}) is already linked to a different person, so nothing was stored.`
        );
        refused.statusCode = 409;
        throw refused;
      }
    }

    const summary = await replaceAccounts(
      connection,
      usableAccounts.map((accountName) => {
        // The server the file was written on travels with the account, and with every
        // guild row it touches: a guild id means nothing without it.
        const world = parsed.accountWorlds.get(accountName) || {};

        return {
          accountName,
          items: parsed.items.filter((item) => item.accountName === accountName),
          alwaysShare: parsed.alwaysShare.filter((entry) => entry.accountName === accountName),
          addonVersion: parsed.addonVersions.get(accountName) || '',
          guilds: parsed.accountGuilds.get(accountName) || new Map(),
          platform: world.platform || 0,
          worldName: world.worldName || '',
          // How long this account keeps an item shared. 0 is a file with no expireDays,
          // and then nothing is ever flagged LAST CHANCE.
          expireDays: parsed.accountExpiryDays.get(accountName) || 0,
        };
      }),
      { sourceFile, userId: user ? user.id : null }
    );

    return summary;
  });

  // The rows are committed, so the new list is real. Announce it before the icon
  // work, which can take a moment, so nobody waits on UESP to see their items.
  const uploaded = (Array.isArray(outcome) ? outcome : [outcome]).filter(Boolean);
  const uploadedItems = uploaded.reduce((sum, entry) => sum + (Number(entry.itemCount) || 0), 0);
  const uploadedAccounts = uploaded.map((entry) => entry.accountName).filter(Boolean);

  if (skippedAccounts.length > 0) {
    warnLine(
      `Upload: left ${skippedAccounts
        .map((entry) => entry.accountName)
        .join(', ')} alone - already linked to a different person`
    );
  }

  // Rows an upload deliberately left alone, because somebody is still waiting on them.
  const heldBack = uploaded.flatMap((entry) =>
    (entry.heldBack || []).map((item) => ({ accountName: entry.accountName, ...item }))
  );

  if (heldBack.length > 0) {
    warnLine(
      `Upload: left ${heldBack.length} item${heldBack.length === 1 ? '' : 's'} as they were because requests are still open - ${heldBack
        .map((item) => `${item.itemName} (${item.requests})`)
        .join(', ')}`
    );
  }

  notifyItemsChanged(
    'upload',
    `${uploadedAccounts.join(', ') || 'An account'} uploaded ${uploadedItems} item${
      uploadedItems === 1 ? '' : 's'
    }`
  );

  // One fetch per new icon, ever: afterwards /icons serves the stored bytes.
  let icons = { fetched: 0, skipped: 0, failed: 0 };

  try {
    icons = await withDatabase((connection) =>
      cacheItemIcons(connection, parsed.items.map((item) => item.icon))
    );

    if (icons.fetched || icons.failed) {
      logLine(`Icons: fetched ${icons.fetched}, already stored ${icons.skipped}, failed ${icons.failed}`);
    }

    if (icons.fetched) {
      // Rows that had no picture a moment ago have one now, so open pages have to
      // draw them a second time.
      notifyItemsChanged(
        'icons',
        `${icons.fetched} item icon${icons.fetched === 1 ? '' : 's'} fetched`
      );
    }
  } catch (error) {
    warnLine(`Could not cache item icons: ${error.message}`);
  }

  return {
    accounts: uploaded,
    accountCount: uploaded.length,
    itemCount: uploaded.reduce((sum, entry) => sum + entry.itemCount, 0),
    alwaysShareCount: uploaded.reduce((sum, entry) => sum + entry.alwaysShareCount, 0),
    removedItems: uploaded.reduce((sum, entry) => sum + (entry.removedItems || 0), 0),
    cancelledRequests: uploaded.reduce((sum, entry) => sum + (entry.cancelledRequests || 0), 0),
    heldBack,
    totalQuantity: uploaded.reduce((sum, entry) => sum + entry.totalQuantity, 0),
    guildCount: parsed.guilds.size,
    iconLookup,
    icons,
    // What the browser needs to say which accounts were not touched.
    skippedAccounts,
    link: user ? 'linked' : 'skipped',
  };
}

app.post('/upload', upload.single('savedvars'), async (req, res) => {
  const user = req.session.user || null;

  if (enabledProviders.length > 0 && !user) {
    res.status(401).json({ error: 'Sign in with Discord or Google before uploading.' });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: 'Choose your ItemShareSavedVars.lua file first.' });
    return;
  }

  try {
    const summary = await applySavedVariablesUpload({
      fileText: req.file.buffer.toString('utf8'),
      sourceFile: req.file.originalname,
      user,
    });

    req.session.accountNames = summary.accounts.map((entry) => entry.accountName);
    res.json(summary);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// ------------------------------------------------------- automatic uploads (GuildSync)
//
// GuildSync watches ItemShareSavedVars.lua on the machine that runs the game and
// posts the file's contents here whenever ESO saves it, so the site stays current
// without anyone opening the page. It is the same work as an upload - same parse,
// same replace, same live update - with a shared token instead of a signed-in
// person, because a file watcher has no browser session.
//
// Off unless INGEST_TOKEN is set, and every call compares it in constant time.
// Whether the file is actually watched, and whether that watching is switched on,
// is GuildSync's business: this only accepts what it is given.
const INGEST_TOKEN = String(process.env.INGEST_TOKEN || '').trim();

function ingestTokenMatches(given) {
  if (!INGEST_TOKEN || !given) {
    return false;
  }

  const expected = Buffer.from(INGEST_TOKEN, 'utf8');
  const actual = Buffer.from(String(given), 'utf8');

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// The body arrives as bytes, not as a form and not necessarily as one known text
// type: a watcher may pipe the file straight off disk (`createReadStream(file)
// .pipe(request)`), which means chunked transfer and no Content-Length at all, and
// it may have gzipped the file on the way. express.raw buffers whatever arrives,
// whatever the Content-Type (including none), and inflates gzip or deflate for us;
// the limit is the same 12 MB the upload page allows.
function ingestBodyText(req) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  // A byte-order mark from a Windows editor would otherwise sit in front of the
  // table name and make an otherwise fine file unreadable.
  return raw.toString('utf8').replace(/^\uFEFF/, '');
}

app.post(
  '/ingest',
  express.raw({ type: () => true, limit: '12mb' }),
  async (req, res) => {
    if (!INGEST_TOKEN) {
      res.status(503).json({
        error: 'Automatic uploads are off on this site: set INGEST_TOKEN in .env and restart.',
      });
      return;
    }

    const header = String(req.get('authorization') || '');
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const given = bearer || String(req.get('x-itemshare-token') || '').trim();

    if (!ingestTokenMatches(given)) {
      res.status(401).json({ error: 'That ingest token is not accepted here.' });
      return;
    }

    const fileText = ingestBodyText(req);

    if (!fileText.trim()) {
      res.status(400).json({
        error: 'Send the contents of ItemShareSavedVars.lua in the request body, streamed or in one piece.',
      });
      return;
    }

    // The watcher knows the real file name; record it so an upload can be traced to
    // the file it came from. Anything longer is trimmed rather than refused.
    const sourceFile = String(req.get('x-itemshare-file') || 'ItemShareSavedVars.lua').slice(0, 200);

    try {
      const summary = await applySavedVariablesUpload({ fileText, sourceFile, user: null });
      logLine(
        `Ingest: ${sourceFile} - ${summary.accounts
          .map((entry) => `${entry.accountName} ${entry.itemCount} items`)
          .join(', ')}`
      );
      res.json({ ...summary, sourceFile });
    } catch (error) {
      warnLine(`Ingest failed: ${error.message}`);
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  }
);

// Icons that an upload could not resolve are retried here, because nothing else
// ever asks again: a blank path stays blank for ever otherwise. A bounded batch
// runs shortly after boot and then on an interval; 0 turns the pass off entirely
// for anyone who would rather not have the server calling out on its own.
const ICON_BACKFILL_INTERVAL_MS = Number(process.env.ICON_BACKFILL_INTERVAL_MS ?? 1000 * 60 * 30);
const ICON_BACKFILL_BATCH = Number(process.env.ICON_BACKFILL_BATCH || 20);

let iconBackfillRunning = false;

async function backfillIcons(reason) {
  if (iconBackfillRunning) {
    return;
  }

  iconBackfillRunning = true;

  try {
    const result = await withDatabase((connection) =>
      backfillItemIcons(connection, { limit: ICON_BACKFILL_BATCH })
    );

    if (result.itemIds) {
      logLine(
        `Icons: ${reason} backfill looked up ${result.itemIds}, resolved ${result.resolved}, ` +
          `filled ${result.rows} rows, fetched ${result.icons.fetched} images`
      );

      if (result.rows > 0) {
        notifyItemsChanged('icons', `${result.rows} row${result.rows === 1 ? '' : 's'} got their icons`);
      }
    }
  } catch (error) {
    warnLine(`Could not backfill item icons: ${error.message}`);
  } finally {
    iconBackfillRunning = false;
  }
}

// Everything that is not a page we serve, including a mistyped address, still gets
// the site's own layout. Icons are images, so they get an empty 404 instead.

// ---------------------------------------------------------------- simulation
// `npm run simulate` runs as its own process. It writes through the same store code
// the site uses, but it cannot reach the sockets this process holds, so after each
// round it says what happened here and this turns that into a push. The token keeps
// the endpoint off unless someone deliberately set one.
const SIMULATE_TOKEN = String(process.env.SIMULATE_TOKEN || '').trim();

/** What `.env` holds for SIMULATE_TOKEN right now. '' when there is no file or no value. */
function simulateTokenInFile() {
  try {
    return String(dotenv.parse(readFileSync(envPath)).SIMULATE_TOKEN || '').trim();
  } catch {
    return '';
  }
}

/** A fingerprint, or the words for "there is none" - never the token itself. */
const describeToken = (value) => (value ? tokenFingerprint(value) : 'no token');

// Where the running value came from, decided once. A value exported in the environment
// wins over the file without dotenv saying so, and the log must not claim the file then.
const SIMULATE_TOKEN_SOURCE = (() => {
  const fromFile = simulateTokenInFile();

  return fromFile && fromFile === SIMULATE_TOKEN ? envPath : 'the environment';
})();

/**
 * Why the file and this process disagree, in the words that match the cause. A token
 * exported in the shell outranks the file, and a file edited after start-up cannot be in
 * this process - telling somebody "the file changed" when the file is right and the shell
 * is wrong sends them to edit the wrong thing.
 */
function simulateTokenDrift() {
  if (!hasEnvFile) {
    return '';
  }

  const onDisk = simulateTokenInFile();

  if (!onDisk || onDisk === SIMULATE_TOKEN) {
    return '';
  }

  return SIMULATE_TOKEN_SOURCE === 'the environment'
    ? ` ${envPath} holds ${describeToken(
        onDisk
      )}, but this process took ${describeToken(
        SIMULATE_TOKEN
      )} from the environment (dotenv never overwrites a variable that is already set), so the file was ignored. Unset SIMULATE_TOKEN for this process, or change it to match the file.`
    : ` ${envPath} now holds ${describeToken(
        onDisk
      )}, and this process loaded ${describeToken(
        SIMULATE_TOKEN
      )} at ${STARTED_LABEL} - the file changed afterwards, so restart the site.`;
}

// The same fingerprint function the simulator uses (lib/simulateToken.js), so the two log
// lines compare directly: same number, same token; different number, a second .env or a
// site that was never restarted after the token was set.
let simulateRefusalLogged = false;

// Constant-time, with the length checked first because timingSafeEqual throws on a length
// mismatch. A blank token on either side is a plain no.
function simulateTokenMatches(given) {
  if (!SIMULATE_TOKEN || !given) {
    return false;
  }

  const expected = Buffer.from(SIMULATE_TOKEN, 'utf8');
  const actual = Buffer.from(String(given), 'utf8');

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Said once per process: the simulator asks every thirty seconds, so a line per attempt
// would bury everything else in the log while saying the same thing.
function refuseSimulate(res, token) {
  if (!simulateRefusalLogged) {
    simulateRefusalLogged = true;
    // The most confusing case is a token that was added or changed after this process
    // read the file: the value in .env looks right and this process cannot see it yet.
    const changed = simulateTokenDrift();

    warnLine(
      SIMULATE_TOKEN
        ? `[SIMULATE] nudge refused: the run sent ${
            token ? `token ${tokenFingerprint(token)}` : 'no token at all'
          }, this site holds ${describeToken(
            SIMULATE_TOKEN
          )}, loaded at ${STARTED_LABEL} from ${SIMULATE_TOKEN_SOURCE}.${changed}`
        : `[SIMULATE] nudge refused: SIMULATE_TOKEN is not set on this site, so the route stays hidden.${changed}`
    );
  }

  // The answer says which of the two it is and which fingerprint this site holds - never
  // the token - so the run can put both numbers side by side. A bare 404 left the
  // operator with nothing to compare and no way to tell a wrong token from a wrong
  // address, which is the whole reason this took so long to find.
  res.status(SIMULATE_TOKEN ? 403 : 404).json({
    ok: false,
    reason: SIMULATE_TOKEN ? 'token-mismatch' : 'token-not-set',
    site: SIMULATE_TOKEN ? tokenFingerprint(SIMULATE_TOKEN) : 'none',
  });
}

// What `npm run simulate` calls before its first action: the same token test and no
// broadcast, so a mismatch is one clear line at the start of a run rather than a silent
// 404 per action ten minutes in.
app.post('/simulate/check', (req, res) => {
  const token = String(req.get('x-itemshare-simulate') || '').trim();

  if (!simulateTokenMatches(token)) {
    refuseSimulate(res, token);
    return;
  }

  res.json({ ok: true, clients: realtime.clients() });
});

app.post('/simulate/nudge', (req, res) => {
  const token = String(req.get('x-itemshare-simulate') || '').trim();

  if (!simulateTokenMatches(token)) {
    refuseSimulate(res, token);
    return;
  }

  const summary = readParam(req.body && req.body.summary).slice(0, 200);

  notifyItemsChanged('simulation', summary || 'Simulated activity');
  res.json({ ok: true, clients: realtime.clients(), revision: realtime.revision() });
});

app.use((req, res) => {
  if (req.path.startsWith('/icons/')) {
    res.status(404).end();
    return;
  }

  if (req.path === '/favicon.ico') {
    res.status(204).end();
    return;
  }

  sendPage(req, res, 404, {
    heading: 'Page not found',
    message: 'That address is not part of ItemShare. The shared item list is on the home page.',
    details: `No route for ${req.method} ${req.path}`,
  });
});

// Uploads are answered in JSON because the page reads them with fetch; anything
// else that throws gets a styled page. Multer's own errors land here too, which is
// how an oversized file stops being an Express stack trace.
app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const status = error.statusCode || (error.code === 'LIMIT_FILE_SIZE' ? 413 : 500);

  // A watched file arrives as a raw body, so its failures come from body-parser
  // rather than from anything here. Say what the sender can change instead of
  // repeating "request entity too large" or zlib's "incorrect header check".
  const ingestMessage =
    error.type === 'entity.too.large'
      ? 'That body is larger than 12 MB. ItemShareSavedVars.lua is well under that, so check what was sent.'
      : error.type === 'entity.parse.failed' || error.code === 'Z_DATA_ERROR'
        ? 'Could not decompress that body. Send it as plain text, or gzip it properly.'
        : error.type === 'encoding.unsupported'
          ? 'That Content-Encoding is not supported. Send plain text, gzip or deflate.'
          : '';

  const message =
    (req.path === '/ingest' && ingestMessage) || error.message || 'Something went wrong.';
  const wantsJson =
    req.path === '/upload' ||
    req.path === '/ingest' ||
    req.xhr ||
    String(req.get('accept') || '').includes('application/json');

  warnLine(`${req.method} ${req.path} failed (${status}): ${message}`);

  if (wantsJson) {
    res.status(status).json({ error: message });
    return;
  }

  sendPage(req, res, status, {
    heading: status === 413 ? 'That file is too large' : 'Something went wrong',
    message,
    details:
      status === 413 ? 'ItemShareSavedVars.lua should be well under 12 MB, so check you picked the right file.' : '',
    tone: 'error',
  });
});

await prepareDatabase().catch((error) => {
  let config = {};
  try {
    config = readConfig();
  } catch {
    // A malformed ITEMSHARE_DATABASE is reported by prepareDatabase itself.
  }
  warnLine(describeConnectionFailure(error, config));
});

// Expired rows are invisible to every query, so this is housekeeping rather than
// correctness: once at startup, then twice a day.
sessionStore
  .prune()
  .then((removed) => {
    if (removed) {
      logLine(`Sessions: removed ${removed} expired row${removed === 1 ? '' : 's'}`);
    }
  })
  .catch((error) => warnLine(`Could not prune expired sessions: ${error.message}`));

setInterval(() => {
  sessionStore.prune().catch(() => {});
}, 1000 * 60 * 60 * 12);

// The countdown has to keep running when nobody is looking. A draft is held in
// MariaDB with its own deadline, and this pass is what releases the ones that ran
// out - including for someone who requested an item and then closed the browser.
//
// Ten seconds is far below the five minutes someone is given, so the release is
// prompt without making the sweep a load of its own; a pass that overlaps itself is
// skipped rather than queued.
const SWEEP_INTERVAL_MS = Number(process.env.REQUEST_SWEEP_INTERVAL_MS || 10000);
let sweepRunning = false;

async function sweepExpiredRequests() {
  if (sweepRunning) {
    return;
  }

  sweepRunning = true;

  try {
    const released = await withDatabase((connection) => expireDueDrafts(connection));

    if (released > 0) {
      notifyItemsChanged(
        'request',
        `${released} unsent request${released === 1 ? '' : 's'} timed out, so the items are free again`
      );
    }
  } catch (error) {
    // A database that is down is not a reason to stop the clock; the holding check
    // in every query already treats a lapsed draft as free, so the next pass can
    // catch up with the row itself.
  } finally {
    sweepRunning = false;
  }
}

if (SWEEP_INTERVAL_MS > 0) {
  // unref'd on purpose: this is housekeeping, not the reason the process exists, so
  // it must not keep the server alive on its own.
  setInterval(sweepExpiredRequests, SWEEP_INTERVAL_MS).unref();
  sweepExpiredRequests();
}

// The sandbox's other people. One small action per tick, while a demo page is open, taken
// against the demo database and announced to the demo room only. A quiet copy with no
// page open costs one comparison per tick.
const DEMO_ACTIVITY_MS = (() => {
  const configured = Number(process.env.DEMO_ACTIVITY_MS ?? 15000);

  if (!Number.isFinite(configured)) {
    return 15000;
  }

  return configured <= 0 ? 0 : Math.max(3000, Math.trunc(configured));
})();

let demoActivityBusy = false;
let demoActivityQuiet = true;

async function tickDemoActivity() {
  if (!demoDatabaseReady) {
    return;
  }

  const watching = activeDemoViewers(demoViewers, Date.now());

  if (watching === 0) {
    if (!demoActivityQuiet) {
      demoActivityQuiet = true;
      logLine('Demo activity: paused - no demo page is open');
    }

    return;
  }

  if (demoActivityQuiet) {
    demoActivityQuiet = false;
    logLine(
      `Demo activity: running - ${watching} demo page${watching === 1 ? '' : 's'} open`
    );
  }

  if (demoActivityBusy) {
    return;
  }

  demoActivityBusy = true;

  try {
    const outcome = await withDatabaseOn(DEMO_DATABASE, async (connection) => {
      // A copy browsed all afternoon must not run down: the shelf is topped up from the
      // demo's own catalogues at most once a minute, and asks the cast made and never
      // followed through on are let go, so a visitor arriving later still finds
      // everything there to request. Cheap, and only while a demo page is open.
      await keepDemoShelfFull(connection);

      return runDemoActivity(connection);
    });

    if (outcome) {
      realtime.notifyDemoChange('simulation', outcome.summary);
      logLine(`[DEMO] ${outcome.summary}`);
    }
  } catch (error) {
    warnLine(`Demo activity: nothing happened - ${error.message}`);
  } finally {
    demoActivityBusy = false;
  }
}

// A random wait, not a fixed beat: each action is followed by a pause drawn between 60%
// and 140% of the interval, the way `npm run simulate` spaces its own actions, so the
// copy reads as a site somebody is using. Re-armed only after a tick finishes, so two
// can never overlap, and unref'd because housekeeping must not hold the process open.
function scheduleDemoActivity(delayMs = demoActivityPause(DEMO_ACTIVITY_MS)) {
  const timer = setTimeout(async () => {
    await tickDemoActivity();
    scheduleDemoActivity();
  }, delayMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return timer;
}

if (DEMO_ACTIVITY_MS > 0) {
  scheduleDemoActivity();
}

httpServer.listen(PORT, () => {
  logLine(`ItemShare upload site listening on http://localhost:${PORT}`);
  logLine('Live updates: socket.io on /socket.io');
  logLine(
    DEMO_ACTIVITY_MS > 0
      ? `Demo activity: one action every ${Math.round(
          (DEMO_ACTIVITY_MS * 0.6) / 1000
        )}-${Math.round((DEMO_ACTIVITY_MS * 1.4) / 1000)}s at random while a demo page is open (DEMO_ACTIVITY_MS)`
      : 'Demo activity: off (DEMO_ACTIVITY_MS=0)'
  );
  logLine(
    enabledProviders.length
      ? `Sign-in providers: ${enabledProviders.map((provider) => provider.label).join(', ')}`
      : 'Sign-in providers: none (set DISCORD_* or GOOGLE_* env vars)'
  );
  // What a simulator run will be met with, and where that value came from. "Armed" hid
  // the two things a person actually needs: which file was read, and when - a token set
  // afterwards cannot be in this process, and the warning below says so in words.
  const tokenOnDisk = hasEnvFile ? simulateTokenInFile() : '';

  if (SIMULATE_TOKEN) {
    logLine(
      `Live pushes: on - this site holds ${describeToken(
        SIMULATE_TOKEN
      )}, loaded at ${STARTED_LABEL} from ${SIMULATE_TOKEN_SOURCE}`
    );
  } else {
    logLine(
      `Live pushes: off - no SIMULATE_TOKEN ${
        hasEnvFile ? `in ${envPath}` : `and no .env at ${envPath}`
      } when this site started at ${STARTED_LABEL}; set one and restart to let npm run simulate refresh open pages`
    );
  }

  const drift = simulateTokenDrift();

  if (drift) {
    warnLine(`Live pushes:${drift}`);
  }

  logLine(`Env file: ${hasEnvFile ? envPath : `${envPath} not found - copy .env.example to .env`}`);
  logLine(`Sign-in stays active for ${SESSION_TTL_DAYS} days (SESSION_TTL_DAYS), stored in MariaDB`);
  logLine(
    SWEEP_INTERVAL_MS > 0
      ? `Unsent requests: held for ${HOLD_MINUTES} minute${HOLD_MINUTES === 1 ? '' : 's'} (REQUEST_HOLD_MINUTES), swept every ${Math.round(SWEEP_INTERVAL_MS / 1000)}s`
      : 'Unsent requests: expiry sweep disabled (REQUEST_SWEEP_INTERVAL_MS=0)'
  );
  logLine(`Database target: ${readConfig().database} (demo: ${DEMO_DATABASE})`);

  if (ICON_BACKFILL_INTERVAL_MS > 0) {
    logLine(
      `Icon backfill: up to ${ICON_BACKFILL_BATCH} missing items every ${Math.round(
        ICON_BACKFILL_INTERVAL_MS / 60000
      )} minutes (ICON_BACKFILL_INTERVAL_MS=0 disables)`
    );

    // Not unref'd: the server is the process, so the pass should live as long as
    // it does. The first run waits a minute so a restart loop cannot hammer UESP.
    setTimeout(() => backfillIcons('startup'), 60 * 1000);
    setInterval(() => backfillIcons('scheduled'), ICON_BACKFILL_INTERVAL_MS);
  } else {
    logLine('Icon backfill: disabled (ICON_BACKFILL_INTERVAL_MS=0)');
  }
});
