// Sessions in MariaDB instead of process memory.
//
// Two things went wrong with the default store. Sessions lived in the process, so
// every restart signed everyone out while their cookie still said otherwise; and
// the cookie itself expired after twelve hours, which looks like being logged out
// at random. A signed-in person should stay signed in until the cookie ages out or
// they pick Log out from the avatar menu.
//
// The store never fails a request. If MariaDB is unhappy, a read is reported as
// "no session" and a write is dropped with a warning: the page already has its own
// database-error card, and turning the session layer into a 500 would replace that
// with a blank screen. The cookie is untouched, so the account is signed back in as
// soon as the database answers again.

import session from 'express-session';

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 30;

// `rolling: true` makes express-session touch the session on every request, which
// would mean a database write per page view. Extending the expiry only when it is
// close keeps that to one write per quarter hour per session.
const TOUCH_INTERVAL_MS = 1000 * 60 * 15;

function epochSeconds(date) {
  return Math.floor(date.getTime() / 1000);
}

function expiryOf(sessionData, fallbackMs) {
  const expires = sessionData && sessionData.cookie && sessionData.cookie.expires;
  const date = expires ? new Date(expires) : null;

  if (date && !Number.isNaN(date.getTime())) {
    return date;
  }

  return new Date(Date.now() + fallbackMs);
}

export class MariaDbSessionStore extends session.Store {
  constructor({ withConnection, ttlMs = DEFAULT_TTL_MS, touchIntervalMs = TOUCH_INTERVAL_MS } = {}) {
    super();

    if (typeof withConnection !== 'function') {
      throw new TypeError('MariaDbSessionStore needs a withConnection(handler) function');
    }

    this.withConnection = withConnection;
    this.ttlMs = ttlMs;
    this.touchIntervalMs = touchIntervalMs;
  }

  get(sid, callback) {
    this.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        'SELECT session_data FROM itemshare_sessions WHERE sid = ? AND expires_at > ?',
        [sid, epochSeconds(new Date())]
      );
      return rows[0] || null;
    })
      .then((row) => {
        if (!row) {
          callback(null, null);
          return;
        }

        try {
          callback(null, JSON.parse(row.session_data));
        } catch (error) {
          // A corrupt row is worse than no row: drop it and sign that person in again.
          console.warn(`Session data for ${sid.slice(0, 8)}... was unreadable: ${error.message}`);
          this.destroy(sid, () => callback(null, null));
        }
      })
      .catch((error) => {
        console.warn(`Could not read session ${sid.slice(0, 8)}...: ${error.message}`);
        callback(null, null);
      });
  }

  set(sid, sessionData, callback) {
    const expiresAt = epochSeconds(expiryOf(sessionData, this.ttlMs));

    this.withConnection((connection) =>
      connection.execute(
        `INSERT INTO itemshare_sessions (sid, session_data, expires_at)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE session_data = VALUES(session_data), expires_at = VALUES(expires_at)`,
        [sid, JSON.stringify(sessionData), expiresAt]
      )
    )
      .then(() => callback && callback(null))
      .catch((error) => {
        console.warn(`Could not store session ${sid.slice(0, 8)}...: ${error.message}`);
        if (callback) {
          callback(null);
        }
      });
  }

  touch(sid, sessionData, callback) {
    const expiresAt = epochSeconds(expiryOf(sessionData, this.ttlMs));
    const staleBefore = epochSeconds(new Date(Date.now() + this.ttlMs - this.touchIntervalMs));

    this.withConnection((connection) =>
      connection.execute(
        'UPDATE itemshare_sessions SET expires_at = ? WHERE sid = ? AND expires_at < ?',
        [expiresAt, sid, staleBefore]
      )
    )
      .then(() => callback && callback(null))
      .catch((error) => {
        console.warn(`Could not extend session ${sid.slice(0, 8)}...: ${error.message}`);
        if (callback) {
          callback(null);
        }
      });
  }

  destroy(sid, callback) {
    this.withConnection((connection) =>
      connection.execute('DELETE FROM itemshare_sessions WHERE sid = ?', [sid])
    )
      .then(() => callback && callback(null))
      .catch((error) => {
        console.warn(`Could not delete session ${sid.slice(0, 8)}...: ${error.message}`);
        if (callback) {
          callback(null);
        }
      });
  }

  /** Removes rows whose cookie has expired. @returns {Promise<number>} rows removed */
  async prune() {
    return this.withConnection(async (connection) => {
      const [result] = await connection.execute('DELETE FROM itemshare_sessions WHERE expires_at < ?', [
        epochSeconds(new Date()),
      ]);
      return result.affectedRows || 0;
    });
  }
}
