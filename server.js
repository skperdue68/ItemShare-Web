#!/usr/bin/env node
// ItemShare upload site: signs in with Discord or Google (both optional),
// accepts ItemShareSavedVars.lua and replaces every shared item for every ESO
// account in the file. Styling follows the GuildSync palette.
//
//   npm start            (reads .env)

import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
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
  getOwnerContacts,
  getRequesterRequests,
  getSubmittedRequests,
  getSharedItemsForViewer,
  getViewerAccounts,
  getViewerFacets,
  getViewerGuilds,
  getBrowsingAccount,
  linkAccountToUser,
  replaceAccounts,
  setBrowsingAccount,
  signInWithProvider,
  submitDrafts,
} from './lib/store.js';
import { filterList } from './lib/filters.js';
import { emailConfig, renderRequestEmail, sendEmail } from './lib/email.js';
import { getItemTip } from './lib/uesp.js';
import { buildProviders } from './lib/providers.js';
import { attachRealtime } from './lib/realtime.js';
import { MariaDbSessionStore } from './lib/sessionStore.js';
import { renderListRegion, renderMessagePage, renderPage } from './lib/views.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read .env by absolute path. The `dotenv/config` shorthand resolves
// .env against the shell's working directory, so starting the server as
// `node server.js` from another folder found no settings at all and the
// site came up with no session secret and no sign-in providers.
const envPath = path.join(__dirname, '.env');
const hasEnvFile = existsSync(envPath);
dotenv.config({ path: envPath });

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
      name: row.item_name || 'Item',
      quantity: Number(row.quantity) || 1,
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
    const message = renderRequestEmail({
      requester: personLabel(user),
      requesterAccount,
      ownerAccount: [...group.owners].join(', '),
      items: group.items,
      siteUrl: config.siteUrl,
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
    `Email: sent ${sent} request email${sent === 1 ? '' : 's'}${skipped ? `, ${skipped} failed` : ''}`
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

      if (accountNames.length === 0) {
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

app.post('/simulate/nudge', (req, res) => {
  const token = String(req.get('x-itemshare-simulate') || '').trim();

  if (!SIMULATE_TOKEN || token !== SIMULATE_TOKEN) {
    res.status(404).end();
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
