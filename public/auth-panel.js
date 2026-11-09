// The registration view: opening "New here? Create an account" puts the ways in away and
// shows the account form. The putting away is CSS - `.auth-panel:has(.auth-signup[open])`
// - so it happens before this file runs, and happens at all when this file never loads.
//
// This only closes it again from Cancel. Cancel is a plain link back to the page, so with
// the script missing it still works: the page arrives with the account form closed and the
// OAuth and email forms back where they were. With a script there is no reason to throw
// the page away, so the click is taken here, the form is cleared, and the summary - the way
// in again - takes the focus.

document.addEventListener('click', (event) => {
  const cancel = event.target.closest ? event.target.closest('[data-cancel-signup]') : null;

  if (!cancel) {
    return;
  }

  const details = cancel.closest('details');

  if (!details) {
    return;
  }

  event.preventDefault();

  details.open = false;

  // What was typed is thrown away with the form: a half-typed password left sitting in a
  // closed disclosure is not something anybody meant to keep.
  const form = details.querySelector('form');

  if (form && form.reset) {
    form.reset();
  }

  const summary = details.querySelector('summary');

  if (summary && summary.focus) {
    summary.focus();
  }
});
