// Why a device was signed out, when the answer is that somebody changed something.
//
// A reset ends every session that person had, because whoever knew the old password must
// not keep an open door. Unlinking an ESO account ends the rest of them, because the page
// each device drew was based on a link that no longer exists. Deleting the rows would leave
// those devices holding a cookie that means nothing: they would arrive at the front page as
// a visitor, which looks like a glitch rather than a decision. So the row is stamped instead
// - the person is taken out of it and a note is left behind - and the first page that meets
// it says why.
//
// The note is news once. Reading it clears it, so somebody who ignores it and comes back
// tomorrow is not told the same thing all over again.
export const PASSWORD_CHANGED = 'password-changed';
export const ACCOUNT_UNLINKED = 'account-unlinked';
export const SIGN_IN_DISABLED = 'sign-in-disabled';

// A day is long enough for a device to be picked up and looked at, and short enough that the
// row is only a note by the time anybody would care about it. A cookie that outlives it means
// the page stops explaining, never that access comes back.
const NOTICE_SECONDS = 60 * 60 * 24;

export const PASSWORD_CHANGED_NOTICE =
  'Your password was changed, so you were signed out here. Sign in again with the new one.';

export const ACCOUNT_UNLINKED_NOTICE =
  'An ESO account was removed from your sign-in, so you were signed out here. Sign in again.';

export const SIGN_IN_DISABLED_NOTICE =
  'Your sign-in was switched off, so you were signed out here. Whoever runs the site can switch it back on.';

const NOTICES = {
  [PASSWORD_CHANGED]: PASSWORD_CHANGED_NOTICE,
  [ACCOUNT_UNLINKED]: ACCOUNT_UNLINKED_NOTICE,
  [SIGN_IN_DISABLED]: SIGN_IN_DISABLED_NOTICE,
};

/** Reads the note a session is carrying and clears it. @returns {string} the note, or '' */
export function takeSignOutNotice(session) {
  if (!session || !session.signOut) {
    return '';
  }

  const note = NOTICES[session.signOut] || '';
  session.signOut = null;
  return note;
}

/**
 * Ends every session this person has except the one that asked.
 *
 * Used when an ESO account is unlinked: the device that made the change can see the result,
 * and every other one was showing a link that has just gone, so it is signed out and told
 * why. `keepSid` is that device's session id, and the comparison is in the statement so two
 * requests cannot race one another.
 *
 * @returns {Promise<number>} how many sessions were ended
 */
export async function signOutOtherSessions(
  connection,
  { userId, keepSid = '', reason = ACCOUNT_UNLINKED } = {}
) {
  const id = Number(userId);

  if (!Number.isInteger(id) || id <= 0) {
    return 0;
  }

  const stampedUntil = Math.floor(Date.now() / 1000) + NOTICE_SECONDS;

  const [result] = await connection.execute(
    `UPDATE itemshare_sessions
        SET session_data = JSON_REMOVE(
              JSON_SET(session_data, '$.signOut', ?),
              '$.user', '$.accountNames'
            ),
            expires_at = LEAST(expires_at, ?)
      WHERE CAST(JSON_EXTRACT(session_data, '$.user.id') AS UNSIGNED) = ?
        AND sid <> ?`,
    [reason, stampedUntil, id, String(keepSid || '')]
  );

  return Number(result?.affectedRows) || 0;
}
