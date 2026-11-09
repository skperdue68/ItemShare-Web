// Who is watching the demo right now.
//
// The sandbox's other people only move while somebody has the demo open. A page says it
// is still there with a small heartbeat, and this is the bookkeeping behind it: a session
// that has said nothing for longer than the lifetime is treated as gone. When none are
// left the activity loop stops, and it starts again when a page comes back - rather than
// running for the lifetime of the process and writing rows nobody is looking at.
//
// Kept separate from the server so the rule can be tested without sockets, timers or a
// database.

/**
 * How long a demo page counts as open after its last heartbeat.
 *
 * Three heartbeats' worth at the pace public/app.js sends them (15s), so one missed tick
 * - a sleeping laptop, a slow request - does not read as a closed page.
 */
export const DEMO_VIEWER_TTL_MS = 45000;

/** Records that this demo page is still open. */
export function noteViewer(viewers, key, now = Date.now()) {
  const id = String(key || '');

  if (id) {
    viewers.set(id, Number(now));
  }

  return viewers;
}

/**
 * Drops the pages that have gone quiet and answers how many are still there.
 *
 * The map is edited in place on purpose: it is the server's one record of who is
 * watching, and a caller that forgot to keep the returned value would otherwise leave
 * stale sessions counted for ever.
 */
export function activeDemoViewers(viewers, now = Date.now(), ttl = DEMO_VIEWER_TTL_MS) {
  let active = 0;

  for (const [key, seen] of viewers) {
    if (Number(now) - Number(seen) > ttl) {
      viewers.delete(key);
      continue;
    }

    active += 1;
  }

  return active;
}
