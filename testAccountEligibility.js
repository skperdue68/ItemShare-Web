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
  // The form only exists once a file has been uploaded - until then there is no platform or
  // server to record, and the dialog is read-only.
  const page=renderPage({...base,accounts:[{...base.accounts[0],lastUpload:{uploaded_at:'2026-11-01 10:00:00'}}]});
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

await test('My Requests counts unsent drafts without submitted or cancelled history',()=>{
  const region=renderListRegion({...base,
    basketRows:[{id:1,status:'draft',quantity:1},{id:2,status:'cancelled',quantity:8}],
    requests:[{id:3,status:'pending'},{id:4,status:'fulfilled'},{id:5,status:'cancelled'}],
    requestHistory:{page:1,totalPages:3,total:12},
    filters:{search:'Briarheart'},
  });
  assert.match(region,/id="tabMine"[\s\S]*?My Requests <span class="tab-count">1<\/span>/);
  assert(!region.includes('Newest first, and only what you actually sent'));
  assert.match(region,/data-request-history-pages/);
  assert.match(region,/historyPage=2/);
  assert.match(region,/q=Briarheart/);
  assert(!region.includes('search=Briarheart'));
});

// ------------------------------------------- what a standing offer can hand over

const guildBase={...base,accounts:[{accountName:'@fresh',guildCount:1,guilds:[{id:1}]}]};

const offerRow=(extra)=>({
  id:31,item_key_hash:'offer-hash',item_name:'Perfect Roe',item_id:60213,
  account_name:'@owner',item_type_name:'Material',quality:4,...extra,
});

await test('an offer offers what its owner holds beyond the reserve',()=>{
  const region=renderListRegion({...guildBase,requestOffers:[offerRow({held_quantity:8,reserve_quantity:3,reserved:2})]});
  assert.match(region,/<td class="num">5<\/td>/,'offered is held less the reserve');
  assert.match(region,/<td class="num held-cell">2<\/td>/,'reserved is what a request stands on');
  assert.match(region,/<td class="num">3<\/td>/,'available is what is left of the offered');
  assert.match(region,/data-request data-kind="offer" data-id="31"/);
  assert.match(region,/Others Inventory <span class="tab-count">1<\/span>/);
});

await test('an offer with nothing left to hand over is not a row to ask from',()=>{
  for(const extra of [{held_quantity:3,reserved:3},{held_quantity:5,reserve_quantity:5}]){
    const region=renderListRegion({...guildBase,requestOffers:[offerRow(extra)]});
    assert(!region.includes('Perfect Roe'),JSON.stringify(extra));
    assert(!region.includes('data-kind="offer" data-id="31"'),JSON.stringify(extra));
  }
});

await test('an offer is a row only when the file says what is held beyond the reserve',()=>{
  // A file that wrote no count is not one copy: the row needs a number in the file that is
  // above the reserve, so silence offers nothing instead of being guessed at.
  for(const extra of [{held_quantity:null},{},{held_quantity:undefined},{held_quantity:0,reserve_quantity:0}]){
    const region=renderListRegion({...guildBase,requestOffers:[offerRow(extra)]});
    assert(!region.includes('Perfect Roe'),JSON.stringify(extra));
    assert(!region.includes('data-request data-kind="offer" data-id="31"'),JSON.stringify(extra));
  }
});

const offerTarget=(extra)=>({
  id:34,account_name:'@owner',item_name:'Perfect Roe',item_id:60213,item_key_hash:'h',
  icon_key:'',quality:4,item_type_name:'Material',trait:'',enchant_name:'',style_name:'',
  required_level:0,required_cp:0,...extra,
});

await test('the server refuses an offer with nothing to hand over, before it writes',async()=>{
  for(const extra of [{held_quantity:0,reserve_quantity:0},{held_quantity:5,reserve_quantity:5}]){
    const queries=[];
    const connection={execute:async(sql)=>{queries.push(sql);
      if(/FROM itemshare_always_share a/.test(sql))return [[offerTarget(extra)],[]];
      return [[],[]];}};
    await assert.rejects(
      store.createRequest(connection,{userId:7,requesterAccounts:['@mine'],itemKind:'offer',itemId:34,quantity:1}),
      (error)=>error.statusCode===409,
      JSON.stringify(extra)
    );
    assert(!queries.some((sql)=>sql.includes('INSERT INTO itemshare_requests')),'nothing is written');
  }
});

await test('the server refuses an offer whose file wrote no count',async()=>{
  const queries=[];
  const connection={execute:async(sql)=>{queries.push(sql);
    if(/FROM itemshare_always_share a/.test(sql))return [[offerTarget({held_quantity:null,reserve_quantity:0})],[]];
    return [[],[]];}};
  await assert.rejects(
    store.createRequest(connection,{userId:7,requesterAccounts:['@mine'],itemKind:'offer',itemId:34,quantity:1}),
    (error)=>error.statusCode===409
  );
  assert(!queries.some((sql)=>sql.includes('INSERT INTO itemshare_requests')),'nothing is written');
});

await test('the server refuses more requests than an offer has copies',async()=>{
  const connection={execute:async(sql)=>{
    if(/FROM itemshare_always_share a/.test(sql))return [[offerTarget({held_quantity:3,reserve_quantity:0})],[]];
    if(/itemshare_requests/.test(sql)&&/SUM/i.test(sql))return [[{reserved:3,total:3,n:3,quantity:3,sum:3}],[]];
    return [[],[]];}};
  await assert.rejects(
    store.createRequest(connection,{userId:7,requesterAccounts:['@mine'],itemKind:'offer',itemId:34,quantity:1}),
    (error)=>error.statusCode===409
  );
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
