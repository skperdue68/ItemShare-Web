import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { getDraftBasket } from './lib/store.js';

const source = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert(from >= 0 && to > from, `Missing source anchors: ${start}`);
  return source.slice(from, to);
}
let failures = 0;
let total = 0;
async function test(name, run) {
  total++;
  try { await run(); console.log(`ok   ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
}

await test('basket data uses the configured hold length rather than five minutes', async () => {
  const connection = {execute: async () => [[{items: 2, quantity: 7, seconds_left: 1799}]]};
  const basket = await getDraftBasket(connection, 1, 30);
  assert.equal(basket.holdMinutes, 30);
  assert.equal(basket.count, 2);
  assert.equal(basket.quantity, 7);
});

await test('cancelled rows that are still visible do not make an empty basket nonempty', () => {
  const rows = [{dataset:{status:'cancelled', requestQuantity:'9'}}];
  const document = {
    querySelector: () => null,
    querySelectorAll: selector => selector.includes('data-status="draft"') ? [] : rows,
  };
  const summary = new Function('document', `let headerBasket = null; ${between('  function basketSummary()', '  /** Keeps the bar')}; return basketSummary();`)(document);
  assert.equal(summary.unique, 0);
  assert.equal(summary.copies, 0);
});

await test('live region updates exclude the cancelled rows from both header counts', () => {
  const code = between('  function applyRegion(html)', '  async function refresh()');
  const draft = {dataset:{status:'draft',requestQuantity:'4'}};
  const cancelled = {dataset:{status:'cancelled',requestQuantity:'8'}};
  const next = {
    dataset:{basketSeconds:'1800',holdMinutes:'30'},
    querySelectorAll: selector => selector.includes('data-status="draft"') ? [draft] : [],
    getAttribute: () => 'new-signature',
    querySelector: () => null,
  };
  let summary;
  const template = {content:{querySelector:()=>next}};
  new Function('document','captureAnchor','syncHeaderBar','listRegion','rememberAcrossReload','window','captureRowTops','reconcileLiveNode','restoreAnchor','animatePanelHeights','animateRowsInto','localiseTimeLabels','relativeTick','noteClosedRequests','syncRequestDialog','applyListSearch',`${code}; applyRegion('');`)(
    {createElement:()=>template,getElementById:()=>null},()=>null,(_held,value)=>{summary=value;},
    {getAttribute:()=> 'old-signature',querySelectorAll:()=>[]},()=>{}, {location:{reload(){ throw new Error('Facet changes must not reload'); }}},
    ()=>new Map(),()=>{},()=>{},()=>{},()=>{},()=>{},()=>{},()=>{},()=>{},()=>{},()=>{}
  );
  assert.equal(summary.unique,1);
  assert.equal(summary.copies,4);
});

await test('successful cancellation applies the returned basket before refreshing the list', async () => {
  const events=[];
  const basket={count:0,quantity:0,secondsLeft:0,holdMinutes:30};
  const code=between('  async function cancelOwnRequest(button)', '  // A request can be closed');
  await new Function('fetch','showToast','syncHeaderBar','refreshAfterChange',`let basketRevision = 0; const lockBasketChanges = async () => () => {}; ${code}; return cancelOwnRequest({dataset:{id:'7'},closest:()=>null});`)(
    async()=>({ok:true,json:async()=>({basket})}),()=>{},
    (held,summary,state)=>events.push({held,summary,state}),()=>events.push('refresh')
  );
  assert.equal(events[0]?.held,false);
  assert.equal(events[0]?.summary.copies,0);
  assert.equal(events.at(-1),'refresh');
});

await test('browsing account changes bypass unload warnings but closing a held basket still warns', () => {
  const handlers={};
  const window={location:{href:'https://itemshare.test/',origin:'https://itemshare.test'},addEventListener:(type,fn)=>{handlers[type]=fn;}};
  const document={addEventListener:(type,fn)=>{handlers[type]=fn;},removeEventListener(){}};
  const context={window,document,URL,basketHeldItems:()=>1};
  vm.runInNewContext(between('let leavePrompt = null;', '// ------------------------------------------------------------------ row motion'),context);
  let warned=false;
  handlers.beforeunload({preventDefault(){warned=true;}});
  assert.equal(warned,true,'closing a tab with drafts is still protected');
  assert.equal(typeof handlers.change,'function','account changes must mark their navigation as internal');
  handlers.change({target:{matches:selector=>selector.includes('data-browsing-account'),form:{getAttribute:()=>'/browsing-account'}}});
  warned=false;
  handlers.beforeunload({preventDefault(){warned=true;}});
  assert.equal(warned,false,'the account switch preserves the basket');
});

await test('rapid bag changes wait until the previous response has been applied', async () => {
  const lock = new Function(`${between('  let basketChangeQueue', '  async function syncHeaderBar')}; return lockBasketChanges;`)();
  const releaseFirst = await lock();
  let secondStarted = false;
  const second = lock().then(release => {secondStarted = true; return release;});
  await Promise.resolve();
  assert.equal(secondStarted,false,'the second mutation cannot overtake the first');
  releaseFirst();
  const releaseSecond = await second;
  assert.equal(secondStarted,true);
  releaseSecond();
});

await test('the header clock uses the server reset rather than an earlier deadline', () => {
  const update = new Function(`${between('  function updateBasketClock', '  function explainFirstHold')}; return updateBasketClock;`)();
  const removed=[];
  const bar={dataset:{deadline:'1000',lapsed:'1'},querySelector:()=>({classList:{remove:name=>removed.push(name)}})};
  update(bar,{holdMinutes:30,secondsLeft:1800,deadline:987654321});
  assert.equal(bar.dataset.deadline,'987654321');
  assert.equal(bar.dataset.seconds,'1800');
  assert.equal(bar.dataset.holdMinutes,'30');
  assert.equal(bar.dataset.lapsed,undefined);
  assert(removed.includes('countdown-fading'));
});

console.log(`\n${total-failures}/${total} passed`);
process.exitCode=failures?1:0;
