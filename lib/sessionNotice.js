// Why a device was signed out, when the answer is "your password changed".
//
// A reset ends every session that person had, because whoever knew the old password must
// not keep an open door. Deleting the rows would leave the other devices holding a cookie
// that means nothing: they would arrive at the front page as a visitor, which looks like
// a glitch rather than a decision. So the row is stamped instead - the person is taken out
// of it and a note is left behind - and the first page that meets it says why.
//
// The note is news once. Reading it clears it, so somebody who ignores it and comes back
// tomorrow is not told the same thing all over again.
export const PASSWORD_CHANGED = 'password-changed';

export const PASSWORD_CHANGED_NOTICE =
  'Your password was changed, so you were signed out here. Sign in again with the new one.';

/** Reads the note a session is carrying and clears it. @returns {string} the note, or '' */
export function takeSignOutNotice(session) {
  if (!session || session.signOut !== PASSWORD_CHANGED) {
    return '';
  }

  session.signOut = null;
  return PASSWORD_CHANGED_NOTICE;
}
