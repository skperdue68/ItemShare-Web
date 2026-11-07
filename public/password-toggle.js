// The eye on a password box: it shows what was typed, and hides it again.
//
// One listener on the document rather than one per box, because the request dialog
// builds its fields after the page has loaded and those boxes need the same eye.
//
// Nothing here is needed to sign in, create an account or reset a password: the button
// is a plain `type="button"`, so with the script missing it does nothing and the box
// stays the password box it already was. The state is carried in `aria-pressed` as well
// as in the picture, so it is readable without the icon.

document.addEventListener('click', (event) => {
  const button = event.target.closest ? event.target.closest('[data-reveal-password]') : null;

  if (!button) {
    return;
  }

  const field = button.closest('[data-password-field]');
  const input = field ? field.querySelector('input') : null;

  if (!input) {
    return;
  }

  const wasShowing = input.type === 'text';

  input.type = wasShowing ? 'password' : 'text';
  button.setAttribute('aria-pressed', wasShowing ? 'false' : 'true');

  const words = wasShowing ? 'Show the password' : 'Hide the password';

  button.setAttribute('aria-label', words);
  button.title = words;

  // Changing the type drops the caret to the start, so it is put back at the end where
  // somebody who has just typed a password expects it.
  input.focus();

  try {
    input.setSelectionRange(input.value.length, input.value.length);
  } catch {
    // Not every input type has a selection, and a box without one is not a failure.
  }
});
