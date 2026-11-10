import fs from 'node:fs';
import { renderSignInPage, renderPage } from '../lib/views.js';

const signedOut = renderSignInPage({ providers: [] });

const emptyData = {
  user: { id: 42, username: 'Demo', provider: 'password', isDemo: true },
  providers: [],
  accounts: [],
  browsingAccount: '',
  sharedItems: [],
  requestItems: [],
  alwaysShare: [],
  requestOffers: [],
  facets: { types: [], owners: [] },
  filters: {},
  requests: [],
  basket: { count: 0, quantity: 0, secondsLeft: 0, holdMinutes: 5 },
  basketRows: [],
  dbError: null,
};
const signedIn = renderPage(emptyData);

fs.mkdirSync('artifacts/preview/brand', { recursive: true });
fs.writeFileSync('artifacts/preview/index.html', signedOut + '<div style="height:1200px"></div>');
fs.writeFileSync('artifacts/preview/signed-in.html', signedIn + '<div style="height:1200px"></div>');
fs.copyFileSync('public/styles.css', 'artifacts/preview/styles.css');
for (const f of ['mark.svg', 'wordmark.svg']) fs.copyFileSync('public/brand/' + f, 'artifacts/preview/brand/' + f);

fs.writeFileSync('artifacts/preview/compare.html', `<!DOCTYPE html>
<html><body style="margin:0;background:#222">
  <div style="color:#ddd;font:12px monospace;padding:4px">signed out</div>
  <iframe id="a" src="/index.html" style="width:1400px;height:110px;border:0"></iframe>
  <div style="color:#ddd;font:12px monospace;padding:4px">signed in</div>
  <iframe id="b" src="/signed-in.html" style="width:1400px;height:110px;border:0"></iframe>
</body></html>`);
console.log('preview written');
