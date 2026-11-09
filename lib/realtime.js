// Real-time item lists over socket.io.
//
// The socket deliberately carries no item data. It says only "something you can
// see has changed", and each browser then re-fetches the list it is allowed to see
// through its own signed-in HTTP request. That keeps the visibility rules in one
// place (lib/store.js), so a mistake in the push path cannot show someone another
// guild's items, and every viewer gets exactly what a page load would have shown.
//
// One process, one broadcast. Several Node processes sharing the database would
// need a shared adapter (@socket.io/mysql): an upload handled by process A would
// otherwise never reach the sockets held by process B.

import { Server } from 'socket.io';

export function attachRealtime({
  httpServer,
  sessionMiddleware,
  path = '/socket.io',
  coalesceMs = 120,
  log = console,
} = {}) {
  const io = new Server(httpServer, {
    path,
    serveClient: true,
    // Polling first so the very first update after load cannot be missed while the
    // websocket is still being negotiated; the client upgrades on its own.
    transports: ['polling', 'websocket'],
  });

  // The same middleware Express uses, so a socket is tied to the same signed cookie
  // as the page that opened it. Without it a push could not tell a member from a
  // stranger, and the next feature that needs "your" items would have no user.
  io.engine.use(sessionMiddleware);

  io.use((socket, next) => {
    const session = socket.request.session || {};
    socket.data.userId = session.user ? session.user.id : null;
    // A demo page gets its own room: the sandbox's activity is real, but it happened
    // only inside the copy, so announcing it to everybody else would be a lie.
    socket.data.isDemo = Boolean(session.user && session.user.isDemo);
    next();
  });

  const DEMO_ROOM = 'demo';

  let clients = 0;
  let revision = 0;
  let pendingReason = null;
  let pendingMessages = [];
  let pendingTimer = null;

  function flush() {
    pendingTimer = null;
    revision += 1;

    const reason = pendingReason || 'items';
    const said = pendingMessages.join('; ');
    // Anything the simulator caused is labelled, in the log and in the browser: a
    // handover nobody really made must not read like one that happened.
    const message = reason === 'simulation' && said ? `[SIMULATE] ${said}` : said;

    const payload = {
      revision,
      reason,
      message,
      at: Date.now(),
    };
    pendingReason = null;
    pendingMessages = [];

    io.emit('items:changed', payload);

    // Read as a sentence: what happened, then who saw it. "revision 7 (request) sent
    // to 1 page" answered neither of the questions someone reading the log has.
    log.log(`Live: ${payload.message || `item list changed (${payload.reason})`} - ${audience()}`);

    return payload;
  }

  /** How many open pages this went to, in words. One socket is one open page. */
  function audience() {
    if (clients === 0) {
      return 'no pages open, so nothing was pushed';
    }

    return `${clients} open page${clients === 1 ? '' : 's'} told to refresh`;
  }

  /**
   * Announces that visible rows may have changed. Calls inside the same short
   * window collapse into one broadcast, because one upload can commit items and
   * then fetch their icons a moment later.
   *
   * `message` is the human summary that ends up in the log, so the caller can say
   * who did what: "@DemoTrader asked for 2 x Soul Gem".
   */
  function notifyChange(reason = 'items', message = '') {
    pendingReason = reason;

    if (message) {
      pendingMessages.push(message);
    }

    if (pendingTimer) {
      return;
    }

    pendingTimer = setTimeout(flush, coalesceMs);
    // Never the reason a process stays alive or shuts down late.
    if (typeof pendingTimer.unref === 'function') {
      pendingTimer.unref();
    }
  }

  io.on('connection', (socket) => {
    clients += 1;

    if (socket.data.isDemo) {
      socket.join(DEMO_ROOM);
    }

    socket.on('disconnect', () => {
      clients = Math.max(0, clients - 1);
    });
  });

  // ------------------------------------------------------------ the demo room
  // Everything a demo session does happens in its own database, so it must not reach an
  // ordinary page - but a demo visitor with two tabs open still deserves the same live
  // updates. This is the same coalesced broadcast, addressed to the demo room only.
  let demoRevision = 0;
  let demoTimer = null;
  let demoMessages = [];

  function demoAudience() {
    const room = io.sockets.adapter.rooms.get(DEMO_ROOM);
    const size = room ? room.size : 0;

    if (size === 0) {
      return 'no demo page open, so nothing was pushed';
    }

    return `${size} demo page${size === 1 ? '' : 's'} told to refresh`;
  }

  function flushDemo() {
    demoTimer = null;
    demoRevision += 1;

    const message = demoMessages.join('; ');
    demoMessages = [];

    const payload = {
      revision: demoRevision,
      reason: 'simulation',
      message,
      at: Date.now(),
      demo: true,
    };

    io.to(DEMO_ROOM).emit('items:changed', payload);
    log.log(`Live demo: ${message || 'the demo copy changed'} - ${demoAudience()}`);

    return payload;
  }

  /**
   * Announces a change that happened inside the demo copy. Only demo pages hear it, and
   * a change made by the visitor themselves is announced the same way, so two demo tabs
   * stay in step without the rest of the site being told anything.
   */
  function notifyDemoChange(reason = 'simulation', message = '') {
    if (message) {
      demoMessages.push(message);
    }

    if (demoTimer) {
      return;
    }

    demoTimer = setTimeout(flushDemo, coalesceMs);

    if (typeof demoTimer.unref === 'function') {
      demoTimer.unref();
    }
  }

  return {
    io,
    notifyChange,
    notifyDemoChange,
    revision: () => revision,
    demoRevision: () => demoRevision,
    clients: () => clients,
    demoClients: () => {
      const room = io.sockets.adapter.rooms.get(DEMO_ROOM);
      return room ? room.size : 0;
    },
    close: () => new Promise((resolve) => io.close(resolve)),
  };
}
