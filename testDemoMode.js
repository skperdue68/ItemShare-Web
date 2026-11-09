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
  DEMO_GUILD,
  DEMO_LOGIN,
  DEMO_PASSWORD,
  DEMO_WORLD,
  databaseForUser,
  demoDatabaseConfig,
  demoRefusal,
  ensureDemoData,
  findDemoSignIn,
} from './lib/demo.js';
import { renderPage, renderSignInPage, renderUploadPage } from './lib/views.js';

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
  assert(DEMO_LOGIN === 'demo' && DEMO_PASSWORD === 'Demo', 'the pair is Demo / Demo');
});

check('the demo account is not the one seedDemo.js writes into real guilds', () => {
  assert(DEMO_ACCOUNT !== '@DemoTrader', 'the demo must use its own account');
});

// ------------------------------------------------------------------- read-only rule
check('every writing route is refused for a demo session', () => {
  const closed = [
    ['POST', '/requests'],
    ['POST', '/requests/submit'],
    ['POST', '/requests/41/cancel'],
    ['POST', '/accounts/add'],
    ['POST', '/accounts/remove'],
    ['POST', '/browsing-account'],
    ['POST', '/upload'],
    ['POST', '/owner/requests'],
  ];

  for (const [method, path] of closed) {
    assert(demoRefusal(method, path), `${method} ${path} should be refused`);
  }
});

check('reading and logging out are still allowed', () => {
  const open = [
    ['GET', '/'],
    ['GET', '/items'],
    ['GET', '/owner/requests'],
    ['POST', '/logout'],
    ['POST', '/auth/email'],
  ];

  for (const [method, path] of open) {
    assert(!demoRefusal(method, path), `${method} ${path} should be allowed`);
  }
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
  assert(identity.params[0] === 'demo', `identity should be "demo", got ${identity.params[0]}`);

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
  assert(connection.calls(/INSERT INTO itemshare_users/).length === 0, 'no second person');
  assert(connection.calls(/INSERT INTO itemshare_shared_items/).length === 0, 'no rewrite');
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
            email: 'demo@itemshare.invalid',
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
  assertMatch(page, /Demo/, 'the demo pair is not mentioned');
  assert(!page.includes('data-item-key'), 'no item may be rendered to a visitor');
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

check('a demo session says so, and offers no way to attach an account', () => {
  const page = renderPage({
    ...emptyData,
    user: { id: 42, username: 'Demo', provider: 'password', isDemo: true },
    accounts: [{ accountName: DEMO_ACCOUNT, itemCount: 9, guildCount: 1, guilds: [] }],
  });

  assertMatch(page, /Demo mode/, 'the banner is missing');
  assertMatch(page, /nothing/i, 'the banner must say nothing is saved');
  assert(!page.includes('Add or remove ESO accounts'), 'a demo must not offer account changes');
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

console.log('');
console.log(`${passed}/${passed + failed} checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
