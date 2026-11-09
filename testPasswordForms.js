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
import { renderResetPasswordPage, renderSignInPage } from './lib/views.js';

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
  `${sourceOf(viewsSource, 'passwordField')}\n${sourceOf(viewsSource, 'emailSignInForm')}\n${sourceOf(viewsSource, 'signUpDetails')}\nreturn emailSignInForm() + signUpDetails();`
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

// --------------------------- the pair is checked before the form is posted

/**
 * The page-side check, run against a stand-in form.
 *
 * The script touches only the document and what the form answers, so plain objects are
 * enough to exercise it: one listener per event, and boxes that remember being focused,
 * marked and cleared.
 */
function loadPasswordCheck() {
  const source = fs.readFileSync(new URL('./public/password-check.js', import.meta.url), 'utf8');
  const listeners = [];
  const document = { addEventListener: (type, fn) => listeners.push({ type, fn }) };

  new Function('document', source)(document);

  const listener = (type) => listeners.find((entry) => entry.type === type);

  return {
    form({ password, confirm }) {
      let form = null;

      const box = (value) => ({
        value,
        focused: false,
        invalid: null,
        focus() {
          this.focused = true;
        },
        setAttribute(name, given) {
          if (name === 'aria-invalid') this.invalid = given;
        },
        removeAttribute() {
          this.invalid = null;
        },
        closest: () => form,
      });

      const boxes = {
        password: box(password),
        confirm: confirm === null ? null : box(confirm),
      };
      const note = { hidden: true, textContent: '' };

      form = {
        querySelector(selector) {
          if (selector === '[data-form-note]') return note;
          if (selector === 'input[name="password"]') return boxes.password;
          if (selector === 'input[name="confirm"]') return boxes.confirm;
          return null;
        },
      };

      return { form, boxes, note };
    },
    submit(target) {
      const event = {
        target,
        preventDefault() {
          this.cancelled = true;
        },
      };

      listener('submit').fn(event);
      return Boolean(event.cancelled);
    },
    type(target) {
      listener('input').fn({ target });
    },
  };
}

t('the two-box forms have a place to say what is wrong, and load the check', () => {
  assert.match(signUp, /data-form-note[^>]*role="alert"/, 'the sign-up form can speak');
  assert.match(reset, /data-form-note[^>]*role="alert"/, 'and so can a reset link');

  assert.match(renderSignInPage({}), /src="\/password-check\.js"/, 'the sign-up form is on the sign-in page');
  assert.match(reset, /src="\/password-check\.js"/, 'a reset link is two boxes of its own');
});

t('a pair that disagrees is stopped on the form, in the server\u2019s words', () => {
  const check = loadPasswordCheck();
  const { form, boxes, note } = check.form({ password: 'hunter22', confirm: 'hunter23' });

  assert.equal(check.submit(form), true, 'the submit is cancelled, so the page stays');
  assert.equal(note.hidden, false, 'and the sentence is shown');
  assert.equal(
    note.textContent,
    passwordConfirmationProblem('hunter22', 'hunter23'),
    'the browser and the server say the same thing'
  );
  assert.equal(boxes.confirm.invalid, 'true', 'the second box is marked');
  assert.equal(boxes.confirm.focused, true, 'and takes the caret');
});

t('a password of the wrong length is stopped the same way', () => {
  const check = loadPasswordCheck();
  const short = check.form({ password: 'hunter2', confirm: 'hunter2' });

  assert.equal(check.submit(short.form), true);
  assert.match(short.note.textContent, /at least 8 characters/);
  assert.equal(short.boxes.password.focused, true, 'the first box is the one to fix');

  const long = check.form({ password: 'x'.repeat(201), confirm: 'x'.repeat(201) });
  assert.equal(check.submit(long.form), true);
  assert.match(long.note.textContent, /at most 200 characters/);
});

t('an empty second box is asked for, not compared to nothing', () => {
  const check = loadPasswordCheck();
  const { form, note } = check.form({ password: 'hunter22', confirm: '' });

  assert.equal(check.submit(form), true);
  assert.equal(note.textContent, passwordConfirmationProblem('hunter22', ''));
});

t('a pair that agrees is posted as usual', () => {
  const check = loadPasswordCheck();
  const { form, note } = check.form({ password: 'hunter22', confirm: 'hunter22' });

  note.hidden = false;
  note.textContent = 'left over from an earlier attempt';

  assert.equal(check.submit(form), false, 'nothing is cancelled');
  assert.equal(note.hidden, true, 'and the old sentence goes');
  assert.equal(note.textContent, '');
});

t('signing in asks once, so that form is left alone', () => {
  const check = loadPasswordCheck();
  const { form } = check.form({ password: 'hunter22', confirm: null });

  assert.equal(check.submit(form), false, 'the one-box form posts untouched');
});

t('typing again clears the sentence and the mark', () => {
  const check = loadPasswordCheck();
  const { form, boxes, note } = check.form({ password: 'hunter22', confirm: 'hunter23' });

  check.submit(form);
  assert.equal(note.hidden, false);
  assert.equal(boxes.confirm.invalid, 'true');

  check.type(boxes.confirm);
  assert.equal(note.hidden, true, 'the sentence goes as soon as it is being fixed');
  assert.equal(note.textContent, '');
  assert.equal(boxes.confirm.invalid, null, 'and the box is no longer marked');
});

// ----------------------------------------------- choosing to make an account

t('the reset link belongs to the sign-in form, above the account form', () => {
  assert.ok(
    panel.indexOf('Forgot your password?') > panel.indexOf('Sign In'),
    'it comes under the button it is about'
  );
  assert.ok(
    panel.indexOf('Forgot your password?') < panel.indexOf('data-signup'),
    'and before the way to make an account'
  );
  assert.doesNotMatch(signUp, /Forgot your password\?/, 'it is not part of the account form');
});

t('registering hides the ways in, and Cancel puts them back', () => {
  const styles = fs.readFileSync(new URL('./public/styles.css', import.meta.url), 'utf8');

  // The disclosure carries the state, so the hiding needs no script and the sign-in half
  // comes back by itself when the account form closes.
  assert.match(
    styles,
    /\.auth-panel:has\(\.auth-signup\[open\]\)\s*\.auth-login\s*\{\s*display:\s*none;/,
    'the OAuth buttons, the email form and the reset link step aside'
  );

  assert.match(signUp, /<div class="auth-signup-actions">/, 'the two buttons share a row');
  assert.ok(
    signUp.indexOf('Create Account') < signUp.indexOf('>Cancel<'),
    'Cancel is to the right of the button that goes forward'
  );
  assert.match(signUp, /<a class="cancel-button" href="\/" data-cancel-signup>Cancel<\/a>/);
  assert.match(
    styles,
    /\.cancel-button \{[^}]*background: #b91c1c/s,
    'red, so it reads as the one that throws the form away'
  );
  assert.match(styles, /\.auth-signup-actions \{[^}]*gap: 10px/s, 'with a little space between');
});

t('only the page with the account form loads the script that closes it', () => {
  assert.match(renderSignInPage({}), /src="\/auth-panel\.js"/, 'the sign-in card closes in place');
  assert.doesNotMatch(reset, /src="\/auth-panel\.js"/, 'a reset link has no account form');
});

t('Cancel closes the form and clears it without leaving the page', () => {
  const source = fs.readFileSync(new URL('./public/auth-panel.js', import.meta.url), 'utf8');
  const listeners = [];
  const document = { addEventListener: (type, fn) => listeners.push({ type, fn }) };

  new Function('document', source)(document);

  let cleared = 0;
  const summary = {
    focused: false,
    focus() {
      this.focused = true;
    },
  };
  const form = {
    reset() {
      cleared += 1;
    },
  };
  const details = {
    open: true,
    querySelector: (selector) => (selector === 'form' ? form : summary),
  };
  const cancel = { closest: (selector) => (selector === 'details' ? details : null) };

  const click = (target) => {
    const event = {
      target,
      preventDefault() {
        this.cancelled = true;
      },
    };

    listeners[0].fn(event);
    return event;
  };

  const elsewhere = click({ closest: () => null });
  assert.equal(elsewhere.cancelled, undefined, 'a click that is not Cancel is left alone');
  assert.equal(details.open, true, 'and changes nothing');

  const pressed = click({ closest: (selector) => (selector === '[data-cancel-signup]' ? cancel : null) });

  assert.equal(pressed.cancelled, true, 'the link does not navigate');
  assert.equal(details.open, false, 'the account form closes');
  assert.equal(cleared, 1, 'and what was typed goes with it');
  assert.equal(summary.focused, true, 'the way in again takes the focus');
});

console.log(`\n${total - failures}/${total} passed`);

process.exit(failures ? 1 : 0);
