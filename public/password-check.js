// The two password boxes on the sign-up and reset forms: nothing is posted until the pair
// agrees and the password is a length the server will keep.
//
// The server checks the same things (`passwordConfirmationProblem` and the length rules in
// lib/passwords.js) and must, because a form posts whether or not a script ever ran. This
// is here so a typo is answered on the form itself, with the caret in the box that needs
// fixing, instead of coming back as a page of its own with nothing typed left on it.
//
// One listener on the document for each event, like /password-toggle.js, and nothing is
// assumed about the page beyond the second box: the sign-in form has one password box and
// is left alone.

const MIN_LENGTH = 8;
const MAX_LENGTH = 200;

const NOTE = '[data-form-note]';
const PASSWORD = 'input[name="password"]';
const CONFIRM = 'input[name="confirm"]';

/**
 * What is wrong with the pair, or '' when the form may be sent.
 *
 * The sentences are the server's own, in the same order: a short password is answered
 * before the pair is compared, so the two sides never disagree about which problem to
 * name first.
 */
function problemWith(password, confirm) {
  if (password.length < MIN_LENGTH) {
    return `Use at least ${MIN_LENGTH} characters for the password.`;
  }

  if (password.length > MAX_LENGTH) {
    return `Use at most ${MAX_LENGTH} characters for the password.`;
  }

  if (confirm.length === 0) {
    return 'Type the password again in the second box, so a typo cannot lock you out.';
  }

  if (confirm !== password) {
    return 'Those two passwords are not the same. Retype both of them, and mind the capitals.';
  }

  return '';
}

function formOf(element) {
  return element && element.closest ? element.closest('form') : null;
}

document.addEventListener('submit', (event) => {
  const form = event.target;

  if (!form || !form.querySelector) {
    return;
  }

  const password = form.querySelector(PASSWORD);
  const confirm = form.querySelector(CONFIRM);

  // One box is a sign-in, not a new password: nothing here applies to it.
  if (!password || !confirm) {
    return;
  }

  const note = form.querySelector(NOTE);
  const problem = problemWith(password.value, confirm.value);

  if (!problem) {
    if (note) {
      note.hidden = true;
      note.textContent = '';
    }

    return;
  }

  // Nothing leaves the page: the submit is cancelled, so both boxes keep what was typed
  // and the sentence appears above the button.
  event.preventDefault();

  if (note) {
    note.textContent = problem;
    note.hidden = false;
  }

  const tooShort = problem.indexOf('characters for the password') !== -1;
  const wrong = tooShort ? password : confirm;

  if (wrong.setAttribute) {
    wrong.setAttribute('aria-invalid', 'true');
  }

  if (wrong.focus) {
    wrong.focus();
  }
});

// Typing again is the answer to every one of those sentences, so the message goes as soon
// as somebody starts correcting it.
document.addEventListener('input', (event) => {
  const form = formOf(event.target);

  if (!form || !form.querySelector) {
    return;
  }

  const note = form.querySelector(NOTE);

  if (note) {
    note.hidden = true;
    note.textContent = '';
  }

  const boxes = [form.querySelector(PASSWORD), form.querySelector(CONFIRM)];

  boxes.forEach((box) => {
    if (box && box.removeAttribute) {
      box.removeAttribute('aria-invalid');
    }
  });
});
