#!/usr/bin/env node
// The password boxes, in both directions: the eye that shows what was typed, and the second
// box that makes signing up ask twice.
//
// The markup is the real markup - the sign-in card is lifted out of lib/views.js by name,
// the page a reset link opens is rendered, and the eye's own script is run against a stand-in
// document - so this fails when the boxes change, not when a copy of them does. The server
// side is checked twice over: the rule itself, and that both routes apply it.
//
//   npm run test:password-forms

import assert from 'node:assert/strict';
import fs from 'node:fs';

import { passwordConfirmationProblem } from './lib/passwords.js';
import { renderResetPasswordPage } from './lib/views.js';

let total = 0;
let failures = 0;

function t(name, fn) {
  total += 1;

  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}

const noop = () => {};

/** How many times `needle` appears in `text`. */
function count(text, needle) {
  return text.split(needle).length - 1;
}

/** The text between two anchors, failing loudly when either has moved. */
function between(text, start, end) {
  const from = text.indexOf(start);

  if (from < 0) {
    throw new Error(`MISSING ANCHOR: ${start}`);
  }

  const to = text.indexOf(end, from);

  if (to < 0) {
    throw new Error(`MISSING ANCHOR: ${end}`);
  }

  return text.slice(from, to);
}

const viewsSource = fs.readFileSync(new URL('./lib/views.js', import.meta.url), 'utf8');

/**
 * One function's source, found by name and closed by counting braces.
 *
 * The parameter list is skipped first, because `function passwordField({ id, label })`
 * opens a brace of its own before the body does - stopping at the first balanced pair
 * would return the signature alone.
 */
function sourceOf(source, name) {
  const at = source.indexOf(`function ${name}(`);

  if (at < 0) {
    throw new Error(`MISSING ANCHOR: function ${name}`);
  }

  let depth = 0;
  let i = source.indexOf('(', at);

  for (; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }

  depth = 0;

  for (i = source.indexOf('{', i); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(at, i + 1);
  }

  throw new Error(`unbalanced function ${name}`);
}

// The sign-in card as the page really draws it: one password box to sign in with, and two
// to make an account with. Both functions are lifted out and run, so the markup below is
// the shipped markup.
const panel = new Function(
  `${sourceOf(viewsSource, 'passwordField')}\n${sourceOf(viewsSource, 'emailSignInPanel')}\nreturn emailSignInPanel();`
)();

const signIn = between(panel, 'action="/auth/email"', '</form>');
const signUp = between(panel, 'action="/auth/email/signup"', '</form>');
const reset = renderResetPasswordPage({ token: 'abc123' });

// ------------------------------------------------------------------- the eye

t('every password box has the eye that shows what was typed', () => {
  assert.equal(count(signIn, 'type="password"'), 1);
  assert.equal(count(signIn, 'data-reveal-password'), 1, 'signing in gets one');
  assert.equal(count(signUp, 'type="password"'), 2);
  assert.equal(count(signUp, 'data-reveal-password'), 2, 'and so does each sign-up box');
  assert.equal(count(reset, 'type="password"'), 2);
  assert.equal(count(reset, 'data-reveal-password'), 2, 'and each box on a reset link');
});

t('a box is wrapped so the eye can find its input', () => {
  for (const [page, name] of [
    [panel, 'the sign-in card'],
    [reset, 'the reset page'],
  ]) {
    assert.equal(
      count(page, 'data-password-field'),
      count(page, 'type="password"'),
      `${name} wraps every box`
    );
  }
});

t('the eye says what it does, in a picture and in words', () => {
  assert.match(panel, /class="password-eye"/, 'an open eye');
  assert.match(panel, /class="password-eye-off"/, 'and one struck through');
  assert.match(panel, /aria-pressed="false"/, 'starting hidden');
  assert.match(panel, /aria-label="Show the password"/);
  assert.match(panel, /title="Show the password"/);
  assert.match(panel, /type="button"/, 'a plain button can never submit the form');
});

t('the eye is on the reset page even though that page has no item list', () => {
  assert.match(reset, /src="\/password-toggle\.js"/);
  assert.equal(reset.includes('/app.js'), false, 'and the list script still stays off it');
  assert.equal(reset.includes('socket.io'), false);
});

t('a click flips the box, the picture and the words, and back again', () => {
  const toggleSource = fs.readFileSync(new URL('./public/password-toggle.js', import.meta.url), 'utf8');
  const listeners = [];
  const document = { addEventListener: (type, fn) => listeners.push({ type, fn }) };

  new Function('document', toggleSource)(document);

  assert.equal(listeners.length, 1, 'one listener for every box on the page');

  const input = {
    type: 'password',
    value: 'hunter2',
    focused: false,
    focus() {
      this.focused = true;
    },
    setSelectionRange: noop,
  };
  const field = { querySelector: () => input };
  const attributes = { 'aria-pressed': 'false' };
  const button = {
    title: '',
    attributes,
    setAttribute(name, value) {
      attributes[name] = value;
    },
    closest: (selector) => (selector === '[data-password-field]' ? field : null),
  };
  const target = {
    closest: (selector) => (selector === '[data-reveal-password]' ? button : null),
  };
  const press = () => listeners[0].fn({ target });

  press();
  assert.equal(input.type, 'text', 'the text is shown');
  assert.equal(attributes['aria-pressed'], 'true');
  assert.equal(button.title, 'Hide the password');
  assert.equal(input.focused, true, 'and the caret stays in the box');

  press();
  assert.equal(input.type, 'password', 'and hidden again');
  assert.equal(attributes['aria-pressed'], 'false');
  assert.equal(button.title, 'Show the password');
});

// -------------------------------------------------- asking for it twice

t('creating an account asks for the password twice', () => {
  assert.equal(count(signUp, 'type="password"'), 2);
  assert.match(signUp, /name="password"/);
  assert.match(signUp, /name="confirm"/, 'the second box posts as confirm');
  assert.match(signUp, /Both boxes have to match/);
  assert.equal(count(signUp, 'minlength="8"'), 2, 'both boxes hold the same minimum');
});

t('signing in still asks once', () => {
  assert.equal(count(signIn, 'name="confirm"'), 0, 'no second box on the way back in');
  assert.match(signIn, /autocomplete="current-password"/);
});

t('the reset page asks twice, and its boxes are told apart', () => {
  const ids = [...reset.matchAll(/<input id="([^"]+)"/g)].map((hit) => hit[1]);

  assert.deepEqual(ids, ['reset-password', 'reset-confirm']);
  assert.match(reset, /autocomplete="new-password"/);
});

t('no two boxes on a page share an id', () => {
  const ids = [...panel.matchAll(/<input id="([^"]+)"/g)].map((hit) => hit[1]);

  assert.deepEqual(ids, ['signin-password', 'signup-password', 'signup-confirm']);
  assert.equal(new Set(ids).size, ids.length);
});

// ------------------------------------------------- the server holds the same rule

t('two copies that agree are fine', () => {
  assert.equal(passwordConfirmationProblem('hunter22', 'hunter22'), '');
});

t('two copies that disagree are refused, and say why', () => {
  const message = passwordConfirmationProblem('hunter22', 'hunter23');

  assert.match(message, /not the same/);
  assert.equal(passwordConfirmationProblem('hunter22', ''), 'Type the password again in the second box, so a typo cannot lock you out.');
});

t('both routes read the second box and refuse a pair that disagrees', () => {
  const serverSource = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');

  assert.equal(
    count(serverSource, "const confirm = String((req.body && req.body.confirm) || '');"),
    3,
    'the sign-up form, the first-request dialog, and the reset link that already read it'
  );
  assert.equal(
    count(serverSource, 'passwordConfirmationProblem(password, confirm)'),
    2,
    'and both ask the same question'
  );
});

t('the request dialog asks twice and checks before it sends', () => {
  const appSource = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');

  assert.match(appSource, /passwordBox\(\{ id: 'guest-password'/, 'the first box');
  assert.match(appSource, /passwordBox\(\{ id: 'guest-confirm'/, 'and the second');
  assert.match(appSource, /confirm\.value !== password\.value/, 'checked before anything is sent');
  assert.match(appSource, /set\(\s*'confirm', confirm\s*\)/, 'and posted with the request');
  assert.match(appSource, /data-dialog-note/, 'with somewhere to say a pair disagreed');
});

console.log(`\n${total - failures}/${total} passed`);

process.exit(failures ? 1 : 0);
