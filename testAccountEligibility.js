import assert from 'node:assert/strict';
import * as store from './lib/store.js';
import {renderPage, renderListRegion} from './lib/views.js';

const base = {
  user:{id:7,username:'Tester',provider:'password'},providers:[],
  accounts:[{accountName:'@fresh',guildCount:0,guilds:[]}],browsingAccount:'@fresh',
  sharedItems:[],requestItems:[],alwaysShare:[],requestOffers:[],facets:{types:[],owners:[]},
  filters:{},requests:[],basketRows:[],basket:{count:0,quantity:0,secondsLeft:0,holdMinutes:30},
};
let total=0,failed=0;
async function test(name,run){total++;try{await run();console.log(`ok   ${name}`);}catch(e){failed++;console.error(`FAIL ${name}\n${e.stack}`);}}

await test('account form defaults to PC and NA without placeholder options',()=>{
  const page=renderPage(base);
  assert(!page.includes('Choose one'));
  assert.match(page,/<option value="2" selected>PC<\/option>/);
  assert.match(page,/<option value="NA Megaserver" selected>NA Megaserver<\/option>/);
});

await test('an account with no guilds sees the upload instruction instead of requestable inventory',()=>{
  const region=renderListRegion({...base,requestItems:[{id:99,item_name:'Hidden gift',account_name:'@owner',item_count:5}]});
  assert.match(region,/data-guild-upload-required/);
  assert(!region.includes('data-item-key="inventory:99"'));
  assert(!region.includes('data-request data-kind="inventory" data-id="99"'));
  assert.match(region,/ItemShareSavedVars\.lua/);
});

await test('known account queries always enforce exact guild/platform/server matching',async()=>{
  const queries=[];
  const connection={execute:async(sql,params)=>{queries.push({sql,params});return [[],[]];}};
  await store.getSharedItemsForViewer(connection,['@fresh']);
  await store.getAlwaysShareForViewer(connection,['@fresh']);
  await store.getViewerFacets(connection,['@fresh']);
  await store.getRequestTarget(connection,['@fresh'],'inventory',99);
  const scoped=queries.filter(q=>/FROM itemshare_shared_items i|FROM itemshare_always_share a/.test(q.sql));
  assert(scoped.length>=4);
  for(const {sql,params} of scoped){
    assert.match(sql,/viewer\.account_name IN/);
    assert.match(sql,/viewer\.platform = (ig|ag)\.platform/);
    assert.match(sql,/viewer\.world_name = (ig|ag)\.world_name/);
    assert(!sql.includes('viewer.platform = 0 OR'),'unknown worlds must not bypass the account scope');
    assert(params.includes('@fresh'));
  }
});

await test('switch reconciliation cancels only inaccessible drafts and keeps eligible copies',async()=>{
  assert.equal(typeof store.reconcileDraftBasket,'function');
  const writes=[];
  const drafts=[{id:1,item_kind:'inventory',shared_item_id:10},{id:2,item_kind:'inventory',shared_item_id:20},{id:3,item_kind:'offer',always_share_id:30}];
  const connection={beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},execute:async(sql,params=[])=>{
    if(sql.includes('FOR UPDATE'))return [[{browsing_eso_account_name:'@fresh'}],[]];
    if(sql.includes('a.linked_at'))return [[{eso_account_name:'@fresh'}],[]];
    if(/SELECT.*FROM itemshare_requests/s.test(sql)&&/status = 'draft'/.test(sql))return [drafts,[]];
    if(/FROM itemshare_shared_items i/.test(sql))return [params.at(-1)===10?[{id:10}]:[],[]];
    if(/FROM itemshare_always_share a/.test(sql))return [[],[]];
    writes.push({sql,params});return [{affectedRows:1},[]];
  }};
  const result=await store.reconcileDraftBasket(connection,{userId:7,accountName:'@fresh',holdMinutes:30});
  assert.equal(result.cancelled,2);
  const cancelled=writes.filter(q=>q.sql.includes("status = 'cancelled'"));
  assert.equal(cancelled.length,2);
  assert(cancelled.some(q=>q.params.includes(2)));
  assert(cancelled.some(q=>q.params.includes(3)));
  assert(!cancelled.some(q=>q.params.includes(1)));
  assert(cancelled.every(q=>q.sql.includes("status = 'draft'")),'sent history must never be cancelled');
  assert(writes.some(q=>q.sql.includes('requester_account_name = ?')&&q.params.includes('@fresh')),'retained holds name the new recipient');
});

await test('a live read for an old browsing account cannot cancel the newly selected account bag',async()=>{
  const queries=[];
  const connection={beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},execute:async(sql)=>{
    queries.push(sql);
    if(sql.includes('FOR UPDATE'))return [[{browsing_eso_account_name:'@two'}],[]];
    if(sql.includes('a.linked_at'))return [[{eso_account_name:'@one'},{eso_account_name:'@two'}],[]];
    return [[],[]];
  }};
  const result=await store.reconcileDraftBasket(connection,{userId:7,accountName:'@one'});
  assert.equal(result.stale,true);
  assert.equal(result.cancelled,0);
  assert(!queries.some(sql=>sql.includes('UPDATE itemshare_requests')));
});

await test('Your requests counts unsent drafts without submitted or cancelled history',()=>{
  const region=renderListRegion({...base,
    basketRows:[{id:1,status:'draft',quantity:1},{id:2,status:'cancelled',quantity:8}],
    requests:[{id:3,status:'pending'},{id:4,status:'fulfilled'},{id:5,status:'cancelled'}],
    requestHistory:{page:1,totalPages:3,total:12},
    filters:{search:'Briarheart'},
  });
  assert.match(region,/id="tabMine"[\s\S]*?Your requests <span class="tab-count">1<\/span>/);
  assert(!region.includes('Newest first, and only what you actually sent'));
  assert.match(region,/data-request-history-pages/);
  assert.match(region,/historyPage=2/);
  assert.match(region,/q=Briarheart/);
  assert(!region.includes('search=Briarheart'));
});

await test('sent history has five rows per page, ordered by most recent completion/cancellation',async()=>{
  assert.equal(typeof store.getRequesterHistory,'function');
  const queries=[];
  const connection={execute:async(sql,params)=>{
    queries.push({sql,params});
    return /COUNT\(\*\)/.test(sql)?[[{total:12}],[]]:[[],[]];
  }};
  const history=await store.getRequesterHistory(connection,7,99);
  assert.equal(history.page,3);
  assert.equal(history.totalPages,3);
  assert.equal(history.total,12);
  assert(queries.some(q=>/LIMIT 5 OFFSET 10/.test(q.sql)));
  assert(queries.some(q=>/ORDER BY COALESCE\(r.closed_at, r.submitted_at, r.created_at\) DESC/.test(q.sql)));
});

console.log(`\n${total-failed}/${total} passed`);process.exitCode=failed?1:0;
