#!/usr/bin/env node
// The delete-user command, checked without a database: what each statement asks, that the
// question marks and the values line up, the order the deletes run in, and what a
// half-typed command line does. The run itself is one transaction over these statements,
// and the leftovers check it uses afterwards is checked here too.
//
//   npm run test:delete-user

import assert from 'node:assert/strict';

import { leftoverChecks, parseArguments, removalPlan } from './deleteUser.js';

let total = 0;
let failures = 0;

function t(name, check) {
  total += 1;

  try {
    check();
    console.log(`ok ${total} - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok ${total} - ${name}`);
    console.error(`  ${error.message}`);
  }
}

const ACCOUNTS = ['@Eva', '@Alt'];
const plan = removalPlan({ userId: 7, accountNames: ACCOUNTS });
const checks = leftoverChecks({ userId: 7, accountNames: ACCOUNTS });

const step = (label) => {
  const found = plan.filter((entry) => entry.label === label);
  assert.equal(found.length, 1, `exactly one step called "${label}"`);
  return found[0];
};

const indexOf = (label) => plan.findIndex((entry) => entry.label === label);

t('every statement has one value for every ?', () => {
  for (const entry of [...plan, ...checks]) {
    const marks = (entry.sql.match(/\?/g) || []).length;
    assert.equal(
      entry.params.length,
      marks,
      `"${entry.label}" has ${marks} ? but ${entry.params.length} values`
    );
  }
});

t('the deletes run before the rows that point at them', () => {
  assert.ok(indexOf('requests asked for or owed on them') < indexOf('their ESO accounts'));
  assert.ok(indexOf('shared items') < indexOf('their ESO accounts'));
  assert.ok(indexOf('standing offers') < indexOf('their ESO accounts'));
  assert.ok(indexOf('their ESO accounts') < indexOf('the person'));
  assert.equal(indexOf('the person'), plan.length - 1, 'the person is the last thing removed');
});

t('a request is matched by the asker, their accounts and the owner', () => {
  const entry = step('requests asked for or owed on them');

  assert.match(entry.sql, /requester_user_id = \?/);
  assert.equal((entry.sql.match(/requester_account_name IN \(\?, \?\)/g) || []).length, 1);
  assert.equal((entry.sql.match(/owner_account_name IN \(\?, \?\)/g) || []).length, 1);
  assert.deepEqual(entry.params, [7, '@Eva', '@Alt', '@Eva', '@Alt']);
});

t('everything their accounts held goes with them', () => {
  for (const label of [
    'shared items',
    'standing offers',
    'guild memberships of their accounts',
    'uploads of their accounts',
  ]) {
    assert.match(step(label).sql, /account_name IN \(\?, \?\)/);
  }

  assert.match(step('other people browsing as one of their accounts').sql, /SET browsing_eso_account_name = ''/);
});

t('the sign-in rows and the person are deleted', () => {
  assert.match(step('signed-in sessions').sql, /JSON_EXTRACT\(session_data, '\$\.user\.id'\)/);
  assert.match(step('sign-in identities').sql, /DELETE FROM itemshare_user_identities/);
  assert.match(step('password').sql, /DELETE FROM itemshare_passwords/);
  assert.match(step('password resets').sql, /DELETE FROM itemshare_password_resets/);
  assert.match(step('the person').sql, /DELETE FROM itemshare_users WHERE id = \?/);
});

t('their codes go, and other people keep what a code granted', () => {
  const detach = step('codes their invitations came from');

  assert.match(detach.sql, /UPDATE itemshare_account_guilds SET granted_code_id = NULL/);
  assert.deepEqual(detach.params, [7]);

  const redemptions = step('redemptions of their codes');

  assert.match(redemptions.sql, /user_id = \?/);
  assert.match(redemptions.sql, /created_by_user_id = \?/);
  assert.deepEqual(redemptions.params, [7, 7]);
  assert.match(step('guild codes they created').sql, /created_by_user_id = \?/);
});

t('a person with no ESO account still has a complete plan', () => {
  const lonely = removalPlan({ userId: 3, accountNames: [] });

  // The subqueries over guild codes are IN (...) lists too, so only an actually empty one
  // or a list of account names that is not there counts as a mistake.
  for (const entry of lonely) {
    assert.doesNotMatch(entry.sql, /IN\s*\(\s*\)/, `"${entry.label}" has an empty IN list`);
  }

  assert.equal(
    lonely.filter((entry) => /account_name IN/.test(entry.sql)).length,
    0,
    'nothing looks for a list of accounts that is not there'
  );
  assert.match(
    lonely.find((entry) => entry.label === 'uploads they made').sql,
    /WHERE user_id = \?/
  );
  assert.match(
    lonely.find((entry) => entry.label === 'their ESO accounts').sql,
    /WHERE user_id = \?$/
  );
  assert.equal(lonely[lonely.length - 1].label, 'the person');

  for (const entry of lonely) {
    assert.equal(
      (entry.sql.match(/\?/g) || []).length,
      entry.params.length,
      `"${entry.label}" has a ? and a value for each other`
    );
  }
});

t('the leftovers check covers everything the plan deletes', () => {
  const labels = new Set(checks.map((entry) => entry.label));

  for (const label of [
    'shared items',
    'standing offers',
    'guild memberships',
    'uploads',
    'accounts',
    'requests',
    'guild codes',
    'code redemptions',
    'sessions',
    'identities',
    'password',
    'password resets',
    'the person',
  ]) {
    assert.ok(labels.has(label), `nothing checks whether "${label}" was left behind`);
  }

  for (const entry of checks) {
    assert.match(entry.sql, /^SELECT COUNT\(\*\) AS found FROM itemshare_/, entry.label);
  }
});

t('one login name and no flags is enough', () => {
  const { options, problems } = parseArguments(['someone@example.com']);

  assert.deepEqual(problems, []);
  assert.equal(options.login, 'someone@example.com');
  assert.equal(options.id, 0);
  assert.equal(options.dryRun, false);
  assert.equal(options.yes, false);
});

t('--id names the person when a login is ambiguous', () => {
  const { options, problems } = parseArguments(['--id', '12', '--yes']);

  assert.deepEqual(problems, []);
  assert.equal(options.id, 12);
  assert.equal(options.yes, true);
});

t('a half-typed command line is refused rather than guessed at', () => {
  assert.equal(parseArguments(['--id']).problems.length, 1, '--id with no value');
  assert.equal(parseArguments(['--id', 'zero']).problems.length, 1, '--id with a word');
  assert.equal(parseArguments(['--nope', 'x']).problems.length, 1, 'an unknown flag');
  assert.equal(parseArguments(['one', 'two']).problems.length, 1, 'two login names');
  assert.equal(parseArguments(['--id', '4', 'someone']).problems.length, 1, 'both an id and a name');
  assert.deepEqual(parseArguments([]).problems, [], 'no arguments is handled by the usage text');
});

t('--list shows the email and password logins on its own', () => {
  const { options, problems } = parseArguments(['--list']);

  assert.deepEqual(problems, []);
  assert.equal(options.list, true);
  assert.equal(options.login, '');
  assert.equal(options.id, 0, 'it does not fall back to a person id');

  assert.equal(
    parseArguments(['--list', 'someone@example.com']).problems.length,
    1,
    'a name beside --list is refused'
  );
  assert.equal(
    parseArguments(['--list', '--id', '4']).problems.length,
    1,
    'so is an id beside it'
  );
});

t('--dry-run changes nothing on its own', () => {
  const { options, problems } = parseArguments(['--dry-run', 'someone@example.com']);

  assert.deepEqual(problems, []);
  assert.equal(options.dryRun, true);
});

console.log(`\n${total - failures}/${total} passed`);

if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
