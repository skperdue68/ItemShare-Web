// The Demo sign-in and the two gates in front of the site.
//
// No MariaDB here, so the database half runs against a connection that records the
// statements it is given and answers with the minimum each caller needs. What is
// checked is the shape of what would be written and the rules that decide what a demo
// session may do - the two things that would be wrong in a way nobody notices until
// somebody has reserved an item that never existed.

import {
  DEMO_ACCOUNT,
  DEMO_DATABASE,
  DEMO_EMAIL,
  DEMO_GUILD,
  DEMO_LOGIN,
  DEMO_PASSWORD,
  DEMO_WORLD,
  copyDemoData,
  databaseForUser,
  demoDatabaseConfig,
  demoRefusal,
  demoRefusalMessage,
  demoRemovalRestores,
  ensureDemoData,
  findDemoSignIn,
} from './lib/demo.js';
import {
  DEMO_CAST,
  castCatalogue,
  castEmail,
  ensureDemoCast,
} from './lib/demoCast.js';
import {
  DEMO_ACTIVITY_SCENARIOS,
  demoActivityPause,
  pickScenario,
} from './lib/demoActivity.js';
import { DEMO_VIEWER_TTL_MS, activeDemoViewers, noteViewer } from './lib/demoPresence.js';
import {
  DEMO_ASK_TTL_MS,
  DEMO_RESTOCK_MS,
  abandonedAsksSql,
  shouldRestock,
} from './lib/demoShelf.js';
import { AGE_HOURS, planAges, untouchedRowsSql } from './lib/itemAges.js';
import { stamp } from './lib/log.js';
import { platformName, readAccountServer, serverChoices, serverLabel } from './lib/serverLabel.js';
import { linkAccountToUser, listAccountServers } from './lib/store.js';
import { emailLine, renderPage, renderSignInPage, renderUploadPage } from './lib/views.js';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}`);
    console.log(`     ${error.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}`);
    console.log(`     ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertMatch(text, pattern, message) {
  if (!pattern.test(text)) {
    throw new Error(`${message} (looked for ${pattern})`);
  }
}

/**
 * A connection that records every statement. `answers` maps a fragment of SQL to the
 * rows that statement returns, so one stub can serve the demo lookup and the writes
 * that follow it.
 */
function fakeConnection({ userRow = null, sharedCount = 0 } = {}) {
  const statements = [];

  return {
    statements,
    calls(pattern) {
      return statements.filter((entry) => pattern.test(entry.sql));
    },
    async execute(sql, params) {
      statements.push({ sql, params: params || [] });

      // mysql2 answers `[rows, fields]`, and the store reads the first element of each
      // call as either a row list or an insert result, so the two shapes must differ.
      if (/^\s*SELECT/i.test(sql)) {
        if (/FROM itemshare_users WHERE is_demo = 1/.test(sql)) {
          return [userRow ? [userRow] : [], {}];
        }
        if (/COUNT\(\*\) AS n FROM itemshare_shared_items/.test(sql)) {
          return [[{ n: sharedCount }], {}];
        }
        return [[], {}];
      }

      return [{ insertId: 7, affectedRows: 1 }, {}];
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
  };
}

// ------------------------------------------------------------------ the constants
check('the demo guild is the one that was asked for, on PC and NA', () => {
  assert(DEMO_GUILD.name === 'Alphabet Mafia', `expected Alphabet Mafia, got ${DEMO_GUILD.name}`);
  assert(DEMO_WORLD.platform === 2, `expected platform 2 (PC), got ${DEMO_WORLD.platform}`);
  assert(DEMO_WORLD.worldName === 'NA Megaserver', `got ${DEMO_WORLD.worldName}`);
  assert(
    DEMO_LOGIN === 'demo@example.com' && DEMO_PASSWORD === 'demo',
    'the pair is demo@example.com / demo'
  );
});

check('the demo account is not the one seedDemo.js writes into real guilds', () => {
  assert(DEMO_ACCOUNT !== '@DemoTrader', 'the demo must use its own account');
});

// ------------------------------------------------------------------ what is refused
check('a demo session may rehearse everything except uploads and password resets', () => {
  const refused = [
    ['POST', '/upload'],
    ['POST', '/auth/email/forgot'],
    ['POST', '/auth/email/reset/abc123'],
    ['POST', '/simulate/nudge'],
  ];

  for (const [method, path] of refused) {
    assert(demoRefusal(method, path), `${method} ${path} must be refused`);
  }

  const allowed = [
    ['POST', '/requests'],
    ['POST', '/requests/submit'],
    ['POST', '/requests/41/cancel'],
    ['POST', '/accounts/add'],
    ['POST', '/accounts/remove'],
    ['POST', '/browsing-account'],
    ['POST', '/owner/requests'],
    ['POST', '/logout'],
    ['POST', '/auth/email'],
    ['GET', '/upload'],
  ];

  for (const [method, path] of allowed) {
    assert(!demoRefusal(method, path), `${method} ${path} must be allowed inside the demo copy`);
  }
});

check('each refusal says what it is about', () => {
  assertMatch(demoRefusalMessage('/upload'), /switched off/i, 'the upload refusal must say so');
  assertMatch(
    demoRefusalMessage('/auth/email/forgot'),
    /reset link/i,
    'the reset refusal must say no link is sent'
  );
});

// ----------------------------------------------------------------------- seeding
await checkAsync('a fresh database gets the demo person, account, guild and items', async () => {
  const connection = fakeConnection();
  const result = await ensureDemoData(connection);

  assert(result.created, 'the person should have been created');
  assert(result.seeded, 'the items should have been written');
  assert(result.userId === 7, `expected user 7, got ${result.userId}`);

  const userInsert = connection.calls(/INSERT INTO itemshare_users/)[0];
  assert(userInsert, 'no user row was written');
  assertMatch(
    userInsert.sql,
    /is_demo\)\s*VALUES \(\?, \?, 0, 1\)/s,
    'the person must be written with is_demo = 1'
  );

  const identity = connection.calls(/INSERT INTO itemshare_user_identities/)[0];
  assert(identity, 'no sign-in identity was written');
  assert(
    identity.params[0] === DEMO_LOGIN,
    `identity should be ${DEMO_LOGIN}, got ${identity.params[0]}`
  );

  const account = connection.calls(/INSERT INTO itemshare_accounts/)[0];
  assert(account, 'the ESO account was never linked to the demo person');
  assert(account.params.includes(DEMO_ACCOUNT), 'the link must name the demo account');
  assert(account.params.includes(2), 'the platform must travel with the account');
  assert(account.params.includes('NA Megaserver'), 'the world must travel with the account');

  const guild = connection.calls(/INSERT INTO itemshare_guilds/)[0];
  assert(guild, 'the guild was never written');
  assert(guild.params.includes('Alphabet Mafia'), 'the guild name must be Alphabet Mafia');
  assert(guild.params.includes(2) && guild.params.includes('NA Megaserver'), 'the guild needs its world');
});

await checkAsync('an existing demo person is not rewritten on every visit', async () => {
  const connection = fakeConnection({ userRow: { id: 42 }, sharedCount: 9 });
  const result = await ensureDemoData(connection);

  assert(result.userId === 42, 'the existing person should be reused');
  assert(!result.created, 'nobody should be created twice');
  assert(!result.seeded, 'existing items must be left alone');
  assert(
    connection
      .calls(/INSERT INTO itemshare_users/)
      .filter((call) => call.params.includes(DEMO_EMAIL)).length === 0,
    'no second demo person'
  );
  assert(connection.calls(/INSERT INTO itemshare_shared_items/).length === 0, 'no rewrite');
});

// --------------------------------------------------------------------- the copy
await checkAsync('the demo copy is filled from the site, with people anonymised', async () => {
  const statements = [];

  const connection = {
    async query(sql) {
      statements.push(sql);

      if (/^SHOW TABLES FROM/.test(sql)) {
        return [
          [
            { 'Tables_in_itemshare': 'itemshare_users' },
            { 'Tables_in_itemshare': 'itemshare_shared_items' },
            { 'Tables_in_itemshare': 'itemshare_sessions' },
            { 'Tables_in_itemshare': 'itemshare_schema_migrations' },
          ],
          {},
        ];
      }

      return [[], {}];
    },
  };

  const result = await copyDemoData(connection, { sourceDatabase: 'itemshare' });
  const sql = statements.join('\n');

  assert(result.copied === 2, `expected 2 tables copied, got ${result.copied}`);
  assert(result.failed.length === 0, 'nothing should have failed');
  assertMatch(
    sql,
    /INSERT INTO `itemshare-demo`\.`itemshare_users` SELECT \* FROM `itemshare`\.`itemshare_users`/,
    'the people must be copied across'
  );
  assert(!sql.includes('itemshare_sessions'), 'sessions must never be copied');
  assert(!sql.includes('itemshare_schema_migrations'), 'the demo keeps its own migration ledger');
  assert(sql.includes('SET SESSION FOREIGN_KEY_CHECKS = 0'), 'foreign keys must be off while copying');
  assertMatch(sql, /UPDATE `itemshare-demo`\.itemshare_users[\s\S]*Member /, 'people must be renamed');
  assert(sql.includes('DELETE FROM `itemshare-demo`.itemshare_passwords'), 'copied passwords must go');
  assert(
    sql.includes('DELETE FROM `itemshare-demo`.itemshare_user_identities'),
    'copied sign-ins must go'
  );
});

await checkAsync('one damaged table does not cost the rest of the copy', async () => {
  const connection = {
    async query(sql) {
      if (/^SHOW TABLES FROM/.test(sql)) {
        return [
          [
            { 'Tables_in_itemshare': 'itemshare_users' },
            { 'Tables_in_itemshare': 'itemshare_requests' },
          ],
          {},
        ];
      }

      if (sql.includes('`itemshare_requests`')) {
        throw new Error('Table is damaged');
      }

      return [[], {}];
    },
  };

  const result = await copyDemoData(connection, { sourceDatabase: 'itemshare' });

  assert(result.copied === 1, `expected 1 table copied, got ${result.copied}`);
  assert(
    result.failed.length === 1 && result.failed[0].table === 'itemshare_requests',
    'the failing table must be reported'
  );
  assert(result.failed[0].error === 'Table is damaged', 'the reason must travel with it');
});

// ------------------------------------------------------------------- the sign-in
await checkAsync('the demo signs in as a person marked demo', async () => {
  const connection = {
    async execute() {
      return [
        [
          {
            id: 42,
            display_name: 'Demo',
            email: 'demo@example.com',
            password_hash: 'scrypt$1$2$3$abc$def',
            is_demo: 1,
          },
        ],
      ];
    },
  };

  const login = await findDemoSignIn(connection);

  assert(login, 'the demo sign-in was not found');
  assert(login.userId === 42, `expected 42, got ${login.userId}`);
  assert(login.isDemo === true, 'isDemo must be true for the demo person');
});

// ------------------------------------------------------------------------ the views
const providers = [
  { key: 'discord', label: 'Discord' },
  { key: 'google', label: 'Google' },
];

const emptyData = {
  user: null,
  providers,
  accounts: [],
  browsingAccount: '',
  sharedItems: [],
  requestItems: [],
  alwaysShare: [],
  requestOffers: [],
  facets: { types: [], owners: [] },
  filters: {},
  requests: [],
  basket: { count: 0, quantity: 0, secondsLeft: 0, holdMinutes: 5 },
  basketRows: [],
  dbError: null,
};

check('a visitor is shown the three ways in and no items', () => {
  const page = renderSignInPage({ providers });

  assertMatch(page, /Sign in with Discord/, 'Discord sign-in is missing');
  assertMatch(page, /Sign in with Google/, 'Google sign-in is missing');
  assertMatch(page, /action="\/auth\/email"/, 'the email and password form is missing');
  assertMatch(page, /demo@example\.com/, 'the demo sign-in is not mentioned');
  assertMatch(page, /password\s*<strong>demo<\/strong>/, 'the demo password is not mentioned');
  assert(!page.includes('data-item-key'), 'no item may be rendered to a visitor');
});

check('the demo pair is boxed rather than another grey hint', () => {
  const page = renderSignInPage({ providers });

  assertMatch(page, /class="demo-callout"/, 'the demo sign-in must be its own box');
  assertMatch(page, /class="demo-callout-body"/, 'the box must carry the explanation');
  assertMatch(page, /demo@example\.com/, 'the demo address must still be in it');
  assertMatch(page, /<strong>demo<\/strong>/, 'the demo password must still be in it');
});

check('the addon links live in the header, once, signed out and signed in', () => {
  const demoPage = renderPage({
    ...emptyData,
    user: { id: 42, username: 'Demo', provider: 'password', isDemo: true },
    accounts: [{ accountName: DEMO_ACCOUNT, itemCount: 9, guildCount: 1, guilds: [] }],
  });
  const uploadGate = renderPage({
    ...emptyData,
    user: { id: 5, username: 'someone', provider: 'password' },
    accounts: [],
  });

  for (const [name, page] of [
    ['sign-in', renderSignInPage({ providers })],
    ['demo', demoPage],
    ['upload gate', uploadGate],
  ]) {
    const copies = (page.match(/class="addon-downloads"/g) || []).length;

    assert(copies === 1, `${name}: expected the addon line once, found ${copies}`);

    const header = page.slice(
      page.indexOf('<header class="top-bar">'),
      page.indexOf('</header>') + '</header>'.length
    );

    assert(header.includes('esoui.com/downloads/dl4533'), `${name}: the addon must sit in the top bar`);
    assert(header.includes('www.minion.gg'), `${name}: Minion must be linked beside it`);
    assert(page.includes('downloads/info4533-ItemShare.html'), `${name}: the ESOUI page must be linked too`);

    // The demo banner used to carry its own copy, which is how the same box appeared
    // twice on one screen.
    const banner = page.slice(page.indexOf('Demo mode'), page.indexOf('Your ESO accounts'));
    assert(!banner.includes('addon-downloads'), `${name}: the demo banner must not repeat it`);
  }
});

check('the demo lets go of asks nobody was going to answer', () => {
  const sql = abandonedAsksSql(3);

  assert(sql.includes("status = 'pending'"), 'only a request still standing can be released');
  assert(
    /requester_account_name IN \(\?, \?, \?\)/.test(sql),
    "only the guildmates' asks are released, never the visitor's own"
  );
  assert(sql.includes('submitted_at < ?'), 'an ask still being filled is left alone');
  assert(/status_reason = \?/.test(sql), 'the release says why, so the history reads properly');
  assert(DEMO_ASK_TTL_MS === 120000, `two minutes, not ${DEMO_ASK_TTL_MS}`);
});

check('a demo restock runs at most once a minute', () => {
  assert(shouldRestock(0, 5000), 'the first call always runs');
  assert(!shouldRestock(1000, 1000 + DEMO_RESTOCK_MS - 1), 'never twice inside the minute');
  assert(shouldRestock(1000, 1000 + DEMO_RESTOCK_MS), 'the next minute it runs again');
  assert(DEMO_RESTOCK_MS === 60000, `a minute, not ${DEMO_RESTOCK_MS}`);
});

check('every line the site prints carries the time it happened', () => {
  const fixed = stamp(new Date(2026, 10, 9, 5, 2, 3));

  assert(fixed === '2026-11-09 05:02:03', `expected 2026-11-09 05:02:03, got "${fixed}"`);
  assert(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp()),
    'a stamp is a date and a time, to the second'
  );
});

check('a fresh shelf is dated across a spread rather than all today', () => {
  const three = planAges(3);

  assert(three.length === 3, 'one age per row');
  assert(three[0] === AGE_HOURS[0], 'the first row gets the oldest age');
  assert(three[2] === AGE_HOURS[AGE_HOURS.length - 1], 'the last row gets the newest age');
  assert(three[0] > three[1] && three[1] > three[2], 'the ages descend');
  assert(planAges(0).length === 0, 'nothing to date is no plan');

  const many = planAges(20);

  assert(many.length === 20, 'every row gets an age');
  assert(
    many.every((hours) => AGE_HOURS.includes(hours)),
    'every age is one the ladder knows, so a fresh database always looks the same'
  );
});

check('only rows nobody has touched since they were inserted are dated', () => {
  const sql = untouchedRowsSql('itemshare_shared_items');

  assert(sql.includes('first_seen_at = last_seen_at'), 'a re-saved row must keep its first date');
  assert(/ORDER BY item_name/.test(sql), 'the same item lands on the same rung every time');

  let refused = false;

  try {
    untouchedRowsSql('itemshare_users');
  } catch {
    refused = true;
  }

  assert(refused, 'a table with no living dates must be refused rather than guessed at');
});

check('attaching an ESO account asks for its platform and server, both required', () => {
  const page = renderPage({
    ...emptyData,
    user: { id: 5, username: 'someone', provider: 'password' },
    accounts: [{ accountName: '@someone', itemCount: 1, guildCount: 1, guilds: [] }],
    accountServers: [
      { platform: 2, worldName: 'EU Megaserver' },
      { platform: 2, worldName: 'PTS' },
    ],
  });

  assertMatch(page, /<select name="platform" required>/, 'the platform must be a required choice');
  assertMatch(page, /<select name="worldName" required>/, 'the server must be a required choice');
  assertMatch(page, /<option value="2">PC<\/option>/, 'platform 2 must be offered by the name the site uses');
  assert(page.includes('>EU Megaserver<'), 'a server already recorded must be offered');
  assert(page.includes('>PTS<'), 'every recorded server is offered, not only the megaservers');
  assert(page.includes('>NA Megaserver<'), 'the known megaservers are offered before the first upload');
});

check('the attach form refuses a body with no platform or no server', () => {
  const known = serverChoices([]);
  assert(known.platforms.length === 1, 'only PC is known before any upload');
  assert(known.worlds.length === 2, 'the two megaservers are the known worlds');

  const recorded = serverChoices([
    { platform: 2, worldName: 'PTS' },
    { platform: 2, worldName: 'PTS' },
  ]);
  assert(recorded.worlds.filter((world) => world === 'PTS').length === 1, 'a server recorded twice is offered once');

  assert(
    serverLabel(readAccountServer({ platform: '2', worldName: 'NA Megaserver' })) === 'PC \u00b7 NA Megaserver',
    'a complete choice reads back as one label'
  );
  assert(readAccountServer({ worldName: 'NA Megaserver' }) === null, 'a platform is required');
  assert(readAccountServer({ platform: '0', worldName: 'NA Megaserver' }) === null, 'platform 0 means "not on a file yet"');
  assert(readAccountServer({ platform: '2', worldName: '   ' }) === null, 'a server is required');
});

await checkAsync('a name attached from the form is written with its platform and server', async () => {
  const log = [];
  const connection = {
    async execute(sql, params = []) {
      log.push({ sql, params });
      return [[], []];
    },
  };

  const outcome = await linkAccountToUser(connection, {
    accountName: '@new-player',
    userId: 9,
    platform: 2,
    worldName: 'EU Megaserver',
  });

  assert(outcome === 'linked', `expected a new link, got ${outcome}`);

  const insert = log.find((call) => /INSERT INTO itemshare_accounts/.test(call.sql));
  assert(insert, 'the account was never written');
  assert(insert.params.includes('EU Megaserver'), 'the server must be written with the name');
  assert(insert.params.includes(2), 'the platform must be written with the name');
  assert(insert.params.includes('@new-player'), 'the name must be written');
});

await checkAsync('re-attaching the demo account keeps the server its file recorded', async () => {
  const log = [];
  const connection = {
    async execute(sql, params = []) {
      log.push({ sql, params });
      if (/SELECT user_id/.test(sql)) {
        return [[{ user_id: 42 }], []];
      }
      return [[], []];
    },
  };

  const outcome = await linkAccountToUser(connection, { accountName: DEMO_ACCOUNT, userId: 42 });
  assert(outcome === 'already-linked', `expected the existing link, got ${outcome}`);

  const update = log.find((call) => /UPDATE itemshare_accounts/.test(call.sql));
  assert(update, 'the account was never re-attached');
  assert(!/platform/.test(update.sql), 'with no form behind it there is no platform to write');
});

await checkAsync('the form reads the servers already recorded in the database', async () => {
  const connection = {
    async execute() {
      return [[{ platform: 2, world_name: 'PTS' }, { platform: 2, world_name: 'EU Megaserver' }], []];
    },
  };

  const rows = await listAccountServers(connection);
  assert(rows.length === 2, `expected two recorded servers, got ${rows.length}`);
  assert(rows[0].worldName === 'PTS' && rows[0].platform === 2, 'the row must come back as platform and name');
});

check('a signed-in person with no ESO account is asked to upload', () => {
  const page = renderPage({
    ...emptyData,
    user: { id: 5, username: 'someone', provider: 'password' },
    accounts: [],
  });

  assertMatch(page, /id="savedvars"/, 'the upload field is missing');
  assertMatch(page, /Upload your ItemShareSavedVariables\.lua/, 'the upload card is missing');
  assert(!page.includes('data-item-key'), 'no item may be listed before an upload');
});

check('the upload page itself carries the drop zone and no list', () => {
  const page = renderUploadPage({ user: { id: 5, username: 'someone' }, providers });

  assertMatch(page, /id="savedvars"/, 'the upload field is missing');
  assert(!page.includes('data-item-key'), 'a list would be a way round the gate');
});

check('a demo session says so, and keeps every tool it can rehearse with', () => {
  const page = renderPage({
    ...emptyData,
    user: { id: 42, username: 'Demo', provider: 'password', isDemo: true },
    accounts: [{ accountName: DEMO_ACCOUNT, itemCount: 9, guildCount: 1, guilds: [] }],
  });

  assertMatch(page, /Demo mode/, 'the banner is missing');
  assertMatch(page, /no email/i, 'the banner must say no email is sent');
  assertMatch(page, /Add or remove ESO accounts/, 'the demo must be able to try the account dialog');
  assertMatch(page, /Process Requests/, 'the demo must be able to try the owner pages');
});

check('an ordinary session shows no demo banner', () => {
  const page = renderPage({
    ...emptyData,
    user: { id: 5, username: 'someone', provider: 'password' },
    accounts: [{ accountName: '@someone', itemCount: 3, guildCount: 1, guilds: [] }],
  });

  assert(!page.includes('Demo mode'), 'the banner must only appear for the demo');
});

check('the demo has a database of its own, apart from the real one', () => {
  assert(DEMO_DATABASE === 'itemshare-demo', `expected itemshare-demo, got ${DEMO_DATABASE}`);
  assert(DEMO_DATABASE !== 'itemshare', 'the demo must not share the real database');
});

check('the demo connection keeps the site settings and swaps only the name', () => {
  const config = demoDatabaseConfig({
    host: 'db.internal',
    port: 3307,
    user: 'itemshare',
    password: 'secret',
    database: 'itemshare',
  });

  assert(config.database === DEMO_DATABASE, `expected ${DEMO_DATABASE}, got ${config.database}`);
  assert(config.host === 'db.internal' && config.port === 3307, 'the host and port must be kept');
  assert(config.user === 'itemshare' && config.password === 'secret', 'the login must be kept');
});

check('the demo database can never be the site database', () => {
  for (const name of ['itemshare-demo', 'ItemShare-Demo', '']) {
    let refused = false;

    try {
      demoDatabaseConfig({ database: name });
    } catch {
      refused = true;
    }

    assert(refused, `"${name}" must be refused, because the demo copy is dropped at startup`);
  }
});

check('only a demo session is pointed at the demo database', () => {
  assert(databaseForUser({ id: 42, isDemo: true }) === DEMO_DATABASE, 'the demo must read the demo copy');
  assert(databaseForUser({ id: 5, isDemo: false }) === null, 'an ordinary person stays in the real one');
  assert(databaseForUser({ id: 5 }) === null, 'a session without the flag stays in the real one');
  assert(databaseForUser(null) === null, 'a visitor has no demo database to read');
});

check('a demo upload card keeps the drop zone but says uploading is switched off', () => {
  const page = renderPage({
    ...emptyData,
    user: { id: 42, username: 'Demo', provider: 'password', isDemo: true },
    accounts: [{ accountName: DEMO_ACCOUNT, itemCount: 9, guildCount: 1, guilds: [] }],
  });

  assertMatch(page, /id="savedvars"/, 'the demo should still see the drop zone');
  assertMatch(page, /id="demoUploadNotice"/, 'the upload restriction is not explained');
  assertMatch(page, /switched off/i, 'the notice must say uploading is switched off');
  assertMatch(page, /sign in as yourself/i, 'the notice must say how to upload for real');
});

check('an ordinary upload card carries no demo restriction', () => {
  const page = renderPage({
    ...emptyData,
    user: { id: 5, username: 'someone', provider: 'password' },
    accounts: [{ accountName: '@someone', itemCount: 3, guildCount: 1, guilds: [] }],
  });

  assert(!page.includes('demoUploadNotice'), 'only a demo may be told uploading is off');
});

// --------------------------------------------------------------------- the cast
check('the demo guild has other people to ask, and none of them is the demo', () => {
  assert(DEMO_CAST.length >= 3, `expected at least three guildmates, got ${DEMO_CAST.length}`);

  const accounts = DEMO_CAST.map((person) => person.account);
  assert(new Set(accounts).size === accounts.length, 'each guildmate is a separate account');
  assert(!accounts.includes(DEMO_ACCOUNT), 'the demo account itself cannot be a guildmate');

  for (const person of DEMO_CAST) {
    const { items } = castCatalogue(person);
    assert(items.length > 0, `${person.account} shares nothing, so nobody can ask them`);
    assert(
      items.every((item) => item && item.name && item.qualityName),
      `${person.account} has a catalogue entry that is not an item`
    );
    assert(
      /@demo-cast\.invalid$/.test(castEmail(person.account)),
      `${person.account} needs an address that cannot receive mail`
    );
  }
});

await checkAsync('the cast is written into the demo guild through the upload path', async () => {
  const connection = fakeConnection();
  const result = await ensureDemoCast(connection, {
    guildId: DEMO_GUILD.id,
    guildName: DEMO_GUILD.name,
    platform: DEMO_WORLD.platform,
    worldName: DEMO_WORLD.worldName,
  });

  assert(
    result.seeded.length === DEMO_CAST.length,
    `expected ${DEMO_CAST.length} seeded, got ${result.seeded.length}`
  );

  const shared = connection.calls(/INSERT INTO itemshare_shared_items/);
  assert(shared.length >= DEMO_CAST.length, 'every guildmate must share at least one item');

  const written = JSON.stringify(shared.map((call) => call.params));
  assert(written.includes('@NightMarket'), 'the guildmates\u2019 items must name their account');

  const links = connection.calls(/INSERT IGNORE INTO itemshare_shared_item_guilds/);
  assert(links.length >= DEMO_CAST.length, 'every shared item must carry its guild link');
  assert(
    links.some((call) => call.params.includes(DEMO_GUILD.id)),
    'the items must be offered to the demo guild'
  );

  const identities = connection.calls(/INSERT INTO itemshare_user_identities/);
  assert(
    identities.some((call) => call.params.includes('demo-cast')),
    'a guildmate needs a person row of its own, kept apart from real sign-ins'
  );
});

await checkAsync('a guildmate who already shares is left alone', async () => {
  const connection = fakeConnection({ sharedCount: 3 });
  const result = await ensureDemoCast(connection, { guildId: DEMO_GUILD.id });

  assert(result.seeded.length === 0, 'nothing should be written again');
  assert(result.kept.length === DEMO_CAST.length, 'every guildmate is already there');
  assert(
    connection.calls(/INSERT INTO itemshare_shared_items/).length === 0,
    'an existing shelf must not be rewritten on every boot'
  );
});

// ----------------------------------------------------------------- the activity
check('every action is reachable, and a request is seen from both sides', () => {
  const seen = new Set(
    [0.05, 0.3, 0.55, 0.85].map((value) => pickScenario(() => value))
  );

  assert(seen.size === DEMO_ACTIVITY_SCENARIOS.length, `expected every scenario, got ${[...seen]}`);
  assert(seen.has('ask') && seen.has('answer'), 'asking and answering must both happen');
});

check('the pause between actions is drawn fresh rather than fixed', () => {
  const shortest = demoActivityPause(15000, () => 0);
  const longest = demoActivityPause(15000, () => 1);

  assert(shortest === 9000, `expected 60% of the base, got ${shortest}`);
  assert(longest === 21000, `expected 140% of the base, got ${longest}`);
  assert(
    shortest !== longest && demoActivityPause(15000, () => 0.5) === 15000,
    'each action must wait a random time, with the configured interval as the average'
  );
  assert(demoActivityPause(0) === 0, '0 means no activity at all');
});

check('a demo page counts as watching until it goes quiet', () => {
  const viewers = new Map();
  noteViewer(viewers, 'a', 1000);
  noteViewer(viewers, 'b', 1000);

  assert(activeDemoViewers(viewers, 1000 + DEMO_VIEWER_TTL_MS) === 2, 'a live page is counted');
  assert(
    activeDemoViewers(viewers, 1000 + DEMO_VIEWER_TTL_MS + 1) === 0,
    'a silent page must stop the activity'
  );
  assert(viewers.size === 0, 'the silent page must be forgotten, not counted for ever');
});

check('the heartbeat a demo page sends is not one of the refusals', () => {
  assert(
    !demoRefusal('POST', '/demo/heartbeat'),
    'the page must be able to say it is still open'
  );
});

check('an ESO account says which platform and server it lives on', () => {
  assert(platformName(2) === 'PC', `expected PC for platform 2, got "${platformName(2)}"`);
  assert(platformName(0) === '', 'an account with no file behind it has no platform');
  assert(
    platformName(7) === 'platform 7',
    'a platform number this site cannot name is shown as itself, never guessed at'
  );
  assert(
    serverLabel({ platform: 2, worldName: 'NA Megaserver' }) === 'PC \u00b7 NA Megaserver',
    'both halves belong on one line'
  );
  assert(serverLabel({ worldName: 'PTS' }) === 'PTS', 'a world without a platform is still shown');
  assert(serverLabel({ platform: 2 }) === 'PC', 'a platform without a world is still shown');
  assert(serverLabel({}) === '', 'nothing known says nothing');
});

check('the accounts dialog shows the platform and the server beside the name', () => {
  const page = renderPage({
    ...emptyData,
    user: { id: 42, username: 'Demo', provider: 'password', isDemo: true },
    accounts: [
      {
        accountName: DEMO_ACCOUNT,
        itemCount: 9,
        guildCount: 1,
        platform: 2,
        worldName: 'NA Megaserver',
        guilds: [],
      },
    ],
  });

  assertMatch(page, /PC \u00b7 NA Megaserver/, 'the account must name its platform and megaserver');
  assert(page.includes(DEMO_ACCOUNT), 'the account must still be named beside them');
});

check('removing the demo account puts it straight back', () => {
  assert(
    demoRemovalRestores({ isDemo: true }, DEMO_ACCOUNT),
    'the demo account is the one the demo browses as, so it must be restored'
  );
  assert(
    !demoRemovalRestores({ isDemo: true }, '@SomeoneElse'),
    'another account really can be removed in the demo'
  );
  assert(
    !demoRemovalRestores({ isDemo: false }, DEMO_ACCOUNT),
    'an ordinary person keeps the removal they asked for'
  );
  assert(!demoRemovalRestores(null, DEMO_ACCOUNT), 'a visitor has nothing to restore');
});

check('the demo shows its own address as a verified sign-in, like anybody else', () => {
  const demo = emailLine({ id: 42, username: 'Demo', isDemo: true, email: '', emailVerified: false });

  assertMatch(demo, /demo@example\.com/, 'the demo address must be shown');
  assertMatch(demo, /\(verified\)/, 'it must read as verified, the way an ordinary sign-in does');
  assert(
    !demo.includes('not shared with this site'),
    'the demo must not look like a provider that withheld its address'
  );

  const provider = emailLine({
    id: 5,
    username: 'someone',
    email: 'them@example.com',
    emailVerified: true,
  });
  assertMatch(provider, /\(verified\)/, 'an ordinary verified address still reads verified');

  const quiet = emailLine({ id: 6, username: 'quiet', email: '', emailVerified: false });
  assertMatch(
    quiet,
    /not shared with this site/,
    'a provider that shares no address must still say so'
  );
});

check('a demo page marks itself so the sandbox knows somebody is watching', () => {
  const demoPage = renderPage({
    ...emptyData,
    user: { id: 42, username: 'Demo', provider: 'password', isDemo: true },
    accounts: [{ accountName: DEMO_ACCOUNT, itemCount: 9, guildCount: 1, guilds: [] }],
  });
  const ordinaryPage = renderPage({
    ...emptyData,
    user: { id: 5, username: 'someone', provider: 'password' },
    accounts: [{ accountName: '@someone', itemCount: 3, guildCount: 1, guilds: [] }],
  });

  assertMatch(demoPage, /<body[^>]*data-demo="1"/, 'the demo page must carry data-demo');
  assert(
    !ordinaryPage.includes('data-demo'),
    'an ordinary page must not keep the sandbox alive'
  );
});

console.log('');
console.log(`${passed}/${passed + failed} checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
