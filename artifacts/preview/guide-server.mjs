// Throwaway preview server: renders the real pages from lib/views.js and serves the real
// stylesheet and brand images, so the guide can be looked at without a database.
//   node artifacts/preview/guide-server.mjs 4321
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { renderGuidePage, renderPage, renderSignInPage } from '../../lib/views.js';

const port = Number(process.argv[2]) || 4321;
const publicDir = path.resolve('public');

const accounts = [{ accountName: '@evainefaye', guildCount: 5, guilds: [{ guild_name: 'G' }] }];

const signedIn = renderPage({
  user: { id: 7, username: 'evainefaye', provider: 'password' },
  providers: [],
  accounts,
  accountServers: [],
  browsingAccount: '@evainefaye',
  sharedItems: [],
  requestItems: [],
  alwaysShare: [],
  requestOffers: [],
  facets: { types: [], owners: [] },
  filters: {},
  requests: [],
  requestHistory: null,
  basket: { count: 0, quantity: 0, secondsLeft: 0, holdMinutes: 30 },
  basketRows: [],
  dbError: null,
});

const pages = {
  '/': renderSignInPage({ providers: [] }),
  '/signed-in': signedIn,
  '/how-to': renderGuidePage({ providers: [] }),
};

const types = { '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pages[pathname]) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pages[pathname]);
    return;
  }

  const file = path.join(publicDir, path.normalize(pathname));
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}).listen(port, '0.0.0.0', () => console.log(`preview on ${port}`));
