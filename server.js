#!/usr/bin/env node
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
  createRequest,
  expireDueDrafts,
  fillKnownIcons,
  getAccountSummary,
  getAlwaysShareForViewer,
  getBasketRows,
  getDraftBasket,
  getFulfillForm,
  getOwnerContacts,
  getOwnerRequests,
  getRequesterNotifications,
  getRequesterRequests,
  getSubmittedRequests,
  getSharedItemsForViewer,
  getViewerAccounts,
  getViewerFacets,
  getViewerGuilds,
  getBrowsingAccount,
  issueRequestEmailToken,
  linkAccountToUser,
  recordFulfillment,
  recordOwnerGroupAnswer,
  recordOwnerAnswer,
  replaceAccounts,
  setBrowsingAccount,
  signInWithProvider,
  submitDrafts,
} from './lib/store.js';
import {
  createPasswordAccount,
  detachAccountFromUser,
  findPasswordLogin,
  notePasswordUsed,
} from './lib/store.js';
import { filterList } from './lib/filters.js';
import { emailConfig, renderRequestEmail, renderStatusEmail, sendEmail } from './lib/email.js';
import { getItemTip } from './lib/uesp.js';
import { buildProviders } from './lib/providers.js';
import { normalizeEsoAccountName } from './lib/accountNames.js';
import {
  emailLooksValid,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  normalizeEmail,
  verifyPassword,
} from './lib/passwords.js';
import { attachRealtime } from './lib/realtime.js';
import { MariaDbSessionStore } from './lib/sessionStore.js';
import {
  renderListRegion,
  renderMessagePage,
  renderOwnerRequestsCard,
  renderOwnerRequestsPage,
  renderPage,
  renderRequestFulfillPage,
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
  console.warn(
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
const sessionStore = new MariaDbSessionStore({ withConnection: withDatabase, ttlMs: SESSION_TTL_MS });

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
// A stylesheet taken from a browser cache written before the deploy is the difference
// between green and red answer buttons and two grey boxes with no layout, so it is sent
// with no-cache and revalidated on every page: unchanged costs a 304, changed is seen.
app.get('/styles.css', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('text/css').sendFile(path.join(__dirname, 'public', 'styles.css'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Socket.IO rides on the same HTTP server as Express, under /socket.io, so live
// updates need no second port, no extra proxy rule and no separate auth.
const httpServer = createServer(app);
const realtime = attachRealtime({ httpServer, sessionMiddleware });
const notifyItemsChanged = realtime.notifyChange;

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
      quality: Number(row.quality) || 0,
    });
  }

  if (groups.size === 0) {
    return { sent: 0, skipped: 0 };
  }

  const config = emailConfig();

  if (!config.configured) {
    console.log(
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
        console.warn(`Email: no answer link for ${group.email}: ${error.message}`);
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
      console.warn(`Email: could not email ${group.email}: ${result.error}`);
    }
  }

  console.log(
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
async function emailAnswered(rows) {
  const ids = (rows || [])
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (ids.length === 0) {
    return { sent: 0, skipped: 0 };
  }

  let notices;

  try {
    notices = await withDatabase((connection) => getRequesterNotifications(connection, ids));
  } catch (error) {
    console.warn(
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
    console.log(
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
      console.warn(`Email: could not tell ${group.email}: ${result.error}`);
    }
  }

  console.log(
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

// Migrations run once at startup; request connections just use the database.
async function prepareDatabase() {
  const config = readConfig();
  const { connection, migrations } = await openDatabase(config);
  await connection.end();
  console.log(`Database ready: ${config.database} on ${config.host}:${config.port}`);
  console.log(`Migrations: ${migrations.length ? migrations.join(', ') : 'already up to date'}`);
}

// A single short lived connection per request keeps the app simple: the traffic
// here is one person uploading one file at a time.
async function withDatabase(handler) {
  const config = readConfig();
  const { connection } = await openDatabase(config, { migrate: false });
  try {
    return await handler(connection, config);
  } finally {
    await connection.end();
  }
}

const SORT_FIELDS = new Set(['type', 'name', 'added']);
const ADDED_WINDOWS = new Set(['1', '7', '30']);

// The sort order is a reading preference, not a filter: it is kept in a small cookie so
// the address bar stays a plain link to the filters, safe to share or bookmark. A
// ?sort= still wins when it is present, so an older bookmark keeps behaving.
const SORT_COOKIE = 'itemshare_sort';

function readSortCookie(header) {
  for (const part of String(header || '').split(';')) {
    const [name, ...rest] = part.split('=');

    if (name && name.trim() === SORT_COOKIE) {
      return decodeURIComponent(rest.join('=').trim());
    }
  }

  return '';
}

function readFilters(query, sortCookie = '') {
  const sort = readParam(query.sort);
  const dir = readParam(query.dir);
  const added = readParam(query.added);
  // "name:desc" - the field and the direction in one small value.
  const remembered = String(sortCookie || '').split(':');
  const chosenSort = sort || remembered[0];
  const chosenDir = dir || remembered[1];

  return {
    // Several types or owners at once arrive as repeated parameters, so they stay
    // lists all the way into the query and the chips under the filter row.
    type: filterList(query.type),
    owner: filterList(query.owner),
    search: readParam(query.q),
    // Only the values the list actually offers get through, so a hand-typed ?sort=
    // or ?added= falls back to the default instead of reaching the query.
    added: ADDED_WINDOWS.has(added) ? added : '',
    sort: SORT_FIELDS.has(chosenSort) && chosenSort !== 'type' ? chosenSort : 'type',
    dir: chosenDir === 'desc' ? 'desc' : 'asc',
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
  };

  try {
    await withDatabase(async (connection) => {
      const accountNames = await viewerAccountNames(req, connection, user);

      // A signed-in person with no upload yet still gets the lists: they have no guilds to
      // compare against, so they are shown everything that is shared, and the page draws
      // every request button disabled. A visitor the site does not know at all is still
      // shown nothing. Asking for an item is refused further down either way, because a
      // request needs an ESO account to be credited to.
      if (accountNames.length === 0 && !user) {
        return;
      }

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
        // for Offering, where nothing a second account shares should disappear.
        const requestScope = data.browsingAccount ? [data.browsingAccount] : accountNames;

        data.facets = await getViewerFacets(connection, requestScope);
        data.sharedItems = await getSharedItemsForViewer(connection, accountNames, filters);
        data.requestItems = await getSharedItemsForViewer(connection, requestScope, filters);
        data.alwaysShare = await getAlwaysShareForViewer(connection, accountNames, filters);
        data.requestOffers = await getAlwaysShareForViewer(connection, requestScope, filters);
      data.requests = user ? await getRequesterRequests(connection, user.id) : [];
      data.basketRows = user ? await getBasketRows(connection, user.id) : [];
      data.basket = user
        ? await getDraftBasket(connection, user.id)
        : { count: 0, quantity: 0, secondsLeft: 0, holdMinutes: HOLD_MINUTES };
    });
  } catch (error) {
    data.dbError = error.message;
  }

  return data;
}  app.get('/', async (req, res) => {
    res
      .type('html')
      .send(renderPage(await collectViewerData(req, readFilters(req.query, readSortCookie(req.headers.cookie)))));
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
app.get('/items', async (req, res) => {    const data = await collectViewerData(req, readFilters(req.query, readSortCookie(req.headers.cookie)));

  if (data.dbError) {
    res.status(503).json({ error: data.dbError });
    return;
  }

  res.set('Cache-Control', 'no-store');
  res.type('html').send(renderListRegion(data));
});

// Asking for an item. The quantity is picked in a dialog, so this answers in JSON
// and the page refreshes its own lists; the socket tells everyone else.
app.post('/requests', async (req, res) => {
  const user = req.session ? req.session.user || null : null;

  if (enabledProviders.length > 0 && !user) {
    res.status(401).json({ error: 'Sign in before asking for an item.' });
    return;
  }
  if (!user) {
    res.status(400).json({ error: 'Requests need a signed-in account, or nobody would know who asked.' });
    return;
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
      const accountNames = await viewerAccountNames(req, connection, user);

      if (accountNames.length === 0) {
        const error = new Error('Upload your own file first: an ESO account is needed to ask from.');
        error.statusCode = 400;
        throw error;
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
        basket: await getDraftBasket(connection, user.id),
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
      heading: 'Your requests could not be loaded',
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
    await emailAnswered(outcome.rows);

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

    await emailAnswered(outcome.rows);

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
    console.warn(`Could not serve icon ${match[1]}: ${error.message}`);
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

function startPersonSession(req, { id, provider, providerLabel, username, email }) {
  req.session.user = {
    id,
    provider,
    providerLabel,
    username,
    email,
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

  if (!accountName) {
    sendPage(req, res, 400, {
      heading: 'That is not an account name',
      message: 'Type the ESO account name, for example @YourAccountName.',
      details: 'Lower case, with an @ in front - the site adds the @ if you leave it out.',
      tone: 'error',
    });
    return;
  }

  try {
    const outcome = await withDatabase((connection) =>
      linkAccountToUser(connection, { accountName, userId: user.id })
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
    const removed = await withDatabase((connection) =>
      detachAccountFromUser(connection, { userId: user.id, accountName })
    );

    if (!removed) {
      sendPage(req, res, 404, {
        heading: 'That account is not attached to you',
        message: 'Nothing was changed.',
        tone: 'error',
      });
      return;
    }

    req.session.accountNames = null;
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
    console.warn(`Could not reuse stored icon paths: ${error.message}`);
  }

  let iconLookup = { resolved: 0, attempted: 0, missing: 0 };

  try {
    iconLookup = await resolveMissingIconPaths(iconEntries);

    if (iconLookup.attempted) {
      console.log(
        `Icons: resolved ${iconLookup.resolved} of ${iconLookup.missing} missing paths on UESP`
      );
    }
  } catch (error) {
    console.warn(`Could not look up icon paths on UESP: ${error.message}`);
  }

  const outcome = await withDatabase(async (connection) => {
    if (user) {
      // Every ESO account in the file belongs to the signed-in person. An
      // account claimed by somebody else stops the whole upload.
      for (const accountName of parsed.accounts) {
        const link = await linkAccountToUser(connection, { accountName, userId: user.id });

        if (link === 'conflict') {
          const conflict = new Error(
            `The ESO account ${accountName} is already linked to a different person.`
          );
          conflict.statusCode = 409;
          throw conflict;
        }
      }
    }

    return replaceAccounts(
      connection,
      parsed.accounts.map((accountName) => ({
        accountName,
        items: parsed.items.filter((item) => item.accountName === accountName),
        alwaysShare: parsed.alwaysShare.filter((entry) => entry.accountName === accountName),
        addonVersion: parsed.addonVersions.get(accountName) || '',
        guilds: parsed.accountGuilds.get(accountName) || new Map(),
      })),
      { sourceFile, userId: user ? user.id : null }
    );
  });

  // The rows are committed, so the new list is real. Announce it before the icon
  // work, which can take a moment, so nobody waits on UESP to see their items.
  const uploaded = (Array.isArray(outcome) ? outcome : [outcome]).filter(Boolean);
  const uploadedItems = uploaded.reduce((sum, entry) => sum + (Number(entry.itemCount) || 0), 0);
  const uploadedAccounts = uploaded.map((entry) => entry.accountName).filter(Boolean);

  // Rows an upload deliberately left alone, because somebody is still waiting on them.
  const heldBack = uploaded.flatMap((entry) =>
    (entry.heldBack || []).map((item) => ({ accountName: entry.accountName, ...item }))
  );

  if (heldBack.length > 0) {
    console.warn(
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
      console.log(`Icons: fetched ${icons.fetched}, already stored ${icons.skipped}, failed ${icons.failed}`);
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
    console.warn(`Could not cache item icons: ${error.message}`);
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
      console.log(
        `Ingest: ${sourceFile} - ${summary.accounts
          .map((entry) => `${entry.accountName} ${entry.itemCount} items`)
          .join(', ')}`
      );
      res.json({ ...summary, sourceFile });
    } catch (error) {
      console.warn(`Ingest failed: ${error.message}`);
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
      console.log(
        `Icons: ${reason} backfill looked up ${result.itemIds}, resolved ${result.resolved}, ` +
          `filled ${result.rows} rows, fetched ${result.icons.fetched} images`
      );

      if (result.rows > 0) {
        notifyItemsChanged('icons', `${result.rows} row${result.rows === 1 ? '' : 's'} got their icons`);
      }
    }
  } catch (error) {
    console.warn(`Could not backfill item icons: ${error.message}`);
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

    console.warn(
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

  console.warn(`${req.method} ${req.path} failed (${status}): ${message}`);

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
  console.warn(describeConnectionFailure(error, config));
});

// Expired rows are invisible to every query, so this is housekeeping rather than
// correctness: once at startup, then twice a day.
sessionStore
  .prune()
  .then((removed) => {
    if (removed) {
      console.log(`Sessions: removed ${removed} expired row${removed === 1 ? '' : 's'}`);
    }
  })
  .catch((error) => console.warn(`Could not prune expired sessions: ${error.message}`));

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

httpServer.listen(PORT, () => {
  console.log(`ItemShare upload site listening on http://localhost:${PORT}`);
  console.log('Live updates: socket.io on /socket.io');
  console.log(
    enabledProviders.length
      ? `Sign-in providers: ${enabledProviders.map((provider) => provider.label).join(', ')}`
      : 'Sign-in providers: none (set DISCORD_* or GOOGLE_* env vars)'
  );
  // What a simulator run will be met with, and where that value came from. "Armed" hid
  // the two things a person actually needs: which file was read, and when - a token set
  // afterwards cannot be in this process, and the warning below says so in words.
  const tokenOnDisk = hasEnvFile ? simulateTokenInFile() : '';

  if (SIMULATE_TOKEN) {
    console.log(
      `Live pushes: on - this site holds ${describeToken(
        SIMULATE_TOKEN
      )}, loaded at ${STARTED_LABEL} from ${SIMULATE_TOKEN_SOURCE}`
    );
  } else {
    console.log(
      `Live pushes: off - no SIMULATE_TOKEN ${
        hasEnvFile ? `in ${envPath}` : `and no .env at ${envPath}`
      } when this site started at ${STARTED_LABEL}; set one and restart to let npm run simulate refresh open pages`
    );
  }

  const drift = simulateTokenDrift();

  if (drift) {
    console.warn(`Live pushes:${drift}`);
  }

  console.log(`Env file: ${hasEnvFile ? envPath : `${envPath} not found - copy .env.example to .env`}`);
  console.log(`Sign-in stays active for ${SESSION_TTL_DAYS} days (SESSION_TTL_DAYS), stored in MariaDB`);
  console.log(
    SWEEP_INTERVAL_MS > 0
      ? `Unsent requests: held for ${HOLD_MINUTES} minute${HOLD_MINUTES === 1 ? '' : 's'} (REQUEST_HOLD_MINUTES), swept every ${Math.round(SWEEP_INTERVAL_MS / 1000)}s`
      : 'Unsent requests: expiry sweep disabled (REQUEST_SWEEP_INTERVAL_MS=0)'
  );
  console.log(`Database target: ${readConfig().database}`);

  if (ICON_BACKFILL_INTERVAL_MS > 0) {
    console.log(
      `Icon backfill: up to ${ICON_BACKFILL_BATCH} missing items every ${Math.round(
        ICON_BACKFILL_INTERVAL_MS / 60000
      )} minutes (ICON_BACKFILL_INTERVAL_MS=0 disables)`
    );

    // Not unref'd: the server is the process, so the pass should live as long as
    // it does. The first run waits a minute so a restart loop cannot hammer UESP.
    setTimeout(() => backfillIcons('startup'), 60 * 1000);
    setInterval(() => backfillIcons('scheduled'), ICON_BACKFILL_INTERVAL_MS);
  } else {
    console.log('Icon backfill: disabled (ICON_BACKFILL_INTERVAL_MS=0)');
  }
});
