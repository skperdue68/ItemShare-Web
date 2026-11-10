import assert from 'node:assert/strict';
import { createDiscordBotStore } from './lib/discord-bot-store.js';
const calls=[];
const connection={execute:async(sql,args)=>{calls.push({sql,args});return [[]];}};
const scope={installationId:'test',discordGuildId:'123',esoGuildId:42,guildName:'Test',platform:1,worldName:'NA',allowProvisional:true};
const store=createDiscordBotStore({withDatabase:fn=>fn(connection),scope});
await assert.rejects(()=>store.item({discordId:'1'},{expectedRecipient:'@Recipient',reference:'inventory:0'}));
await assert.rejects(()=>store.request({discordId:'1'},{expectedRecipient:'@Recipient',reference:'inventory:1',quantity:21,interactionId:'x'}));
await store.browse({discordId:'1'},{search:'sword',category:'Weapon'});
assert.equal(calls.length,2);
for(const {sql,args} of calls){assert.match(sql,/guild_id = \?/);assert.match(sql,/platform = \?/);assert.match(sql,/world_name = \?/);assert.deepEqual(args.slice(0,3),[42,1,'NA']);assert.ok(args.includes('%sword%'));assert.ok(args.includes('Weapon'));if(sql.includes("item_kind = 'inventory'"))assert.match(sql,/fulfilled/);assert.match(sql,/expires_at > NOW/);}
console.log('Discord store scope and validation tests passed');
// Stateful SQL stub exercises the real createRequest path, preserving unrelated drafts.
let pending=false,committed=0,rolledBack=0,idempotency=null;
const statements=[];
const db={beginTransaction:async()=>{},commit:async()=>{committed++;},rollback:async()=>{rolledBack++;},execute:async(sql,args=[])=>{
 sql=sql.replace(/\s+/g, " ").trim();
 statements.push({sql,args});
 if(sql.startsWith('INSERT INTO itemshare_discord_interactions')){idempotency??={discord_id:args[2],body_hash:args[3],response_json:null};return [{affectedRows:1}];}
 if(sql.startsWith('SELECT discord_id, body_hash'))return [[idempotency]];
 if(sql.startsWith('UPDATE itemshare_discord_interactions')){idempotency.response_json=args[1];return [{affectedRows:1}];}
 if(sql.includes('FROM itemshare_discord_associations'))return [[{discord_id:'1',eso_account:'@Recipient',status:'provisional',selected:1}]];
 if(sql.startsWith('SELECT user_id FROM itemshare_user_identities'))return [[{user_id:7}]];
 if(sql.startsWith('SELECT eso_account_name FROM itemshare_accounts'))return [[]];
 if(sql.startsWith('SELECT user_id FROM itemshare_accounts'))return [[]];
 if(sql.includes('AS free_quantity'))return [[{id:9,item_name:'Sword',account_name:'@Owner',item_count:10,free_quantity:8}]];
 if(sql.startsWith('SELECT DISTINCT i.id'))return [[{id:9,item_name:'Sword',account_name:'@Owner',item_count:10}]];
 if(sql.includes('AS reserved'))return [[{reserved:2}]];
 if(sql.includes('AS delivered'))return [[{delivered:0}]];
 if(sql.includes('SELECT viewer.account_name'))return [[]];
 if(sql.startsWith('INSERT INTO itemshare_requests'))return [{insertId:99}];
 if(sql.startsWith('SELECT * FROM itemshare_requests'))return [[{id:99,status:'pending',requester_user_id:7,item_name:'Sword'}]];
 if(sql.includes("SET requester_account_name = ?, status = 'pending'")){pending=true;assert.deepEqual(args,['@recipient',99,7]);return [{affectedRows:1}];}
 if(sql.includes('FROM itemshare_requests'))return [[]];
 if(sql.includes('FROM itemshare_accounts a'))return [[]];
 return [{affectedRows:1}];
}};
const transactional=createDiscordBotStore({withDatabase:fn=>fn(db),scope});
const result=await transactional.request({discordId:'1',username:'Person'},{expectedRecipient:'@Recipient',reference:'inventory:9',quantity:2,interactionId:'abc'});
assert.equal(pending,true);assert.equal(result.request.id,99);assert.equal(result.internal.user.id,7);assert.equal(committed,1);
assert.ok(statements.some(s=>s.sql.includes('FOR UPDATE')&&s.sql.includes('free_quantity')));
assert.ok(!statements.some(s=>s.sql.includes('SET expires_at')),'Discord never resets the website basket clock');
assert.ok(!statements.some(s=>s.sql.includes("status = 'draft'")&&s.sql.includes('ORDER BY')&&s.sql.includes('LIMIT 1')),'Discord never looks up a draft to combine');
const again=await transactional.request({discordId:'1'},{expectedRecipient:'@Recipient',reference:'inventory:9',quantity:2,interactionId:'abc'});
assert.equal(again.duplicate,true);assert.equal(again.internal,undefined);
assert.equal(statements.filter(s=>s.sql.startsWith('INSERT INTO itemshare_requests')).length,1);
await assert.rejects(()=>transactional.request({discordId:'2'},{expectedRecipient:'@Recipient',reference:'inventory:9',quantity:2,interactionId:'abc'}),e=>e.code==='REPLAY_CONFLICT');
assert.equal(rolledBack,1);
console.log('Discord immediate request, draft isolation and replay tests passed');
// Reject unavailable stock before creating a row and preserve the rollback boundary.
const outOfStockDb={...db,execute:async(sql,args)=>{
 if(sql.includes('AS free_quantity'))return [[{id:9,item_name:'Sword',account_name:'@Owner',item_count:10,free_quantity:0}]];
 return db.execute(sql,args);
}};
idempotency=null;
const outOfStock=createDiscordBotStore({withDatabase:fn=>fn(outOfStockDb),scope});
await assert.rejects(()=>outOfStock.request({discordId:'1'},{expectedRecipient:'@Recipient',reference:'inventory:9',quantity:1,interactionId:'no-stock'}),e=>e.code==='OUT_OF_STOCK');
const rejectedDb={...db,execute:async(sql,args)=>sql.includes('FROM itemshare_discord_associations')?[[{discord_id:'1',eso_account:'@Recipient',status:'rejected',selected:1}]]:db.execute(sql,args)};
idempotency=null;
const rejected=createDiscordBotStore({withDatabase:fn=>fn(rejectedDb),scope,resolveConfirmedAccounts:async()=>[{esoAccount:'@Recipient'}]});
await assert.rejects(()=>rejected.request({discordId:'1'},{expectedRecipient:'@Recipient',reference:'inventory:9',quantity:1,interactionId:'rejected'}),e=>e.code==='RECIPIENT_REQUIRED');
console.log('Discord stock rollback and rejected confirmation tests passed');

// The source claim policy is rechecked at selection and at final submission.
const blocked = createDiscordBotStore({
  withDatabase: fn => fn(db), scope, recipientClaimAllowed: async () => false,
});
await assert.rejects(() => blocked.account({discordId:'1'}, {esoAccount:'@Recipient'}),
  error => error.code === 'RECIPIENT_BLOCKED' && error.statusCode === 403);
idempotency = null;
await assert.rejects(() => blocked.request({discordId:'1'}, {
  expectedRecipient:'@Recipient', reference:'inventory:9', quantity:1, interactionId:'blocked',
}), error => error.code === 'RECIPIENT_BLOCKED' && error.statusCode === 403);

// An uploaded but unowned ESO account is not another person's verified link.
const unownedDb = {...db, execute: async (sql,args) => {
  if (sql.includes('SELECT a.user_id, i.provider_user_id')) return [[{user_id:null,provider_user_id:null}]];
  if (sql.includes('SELECT user_id FROM itemshare_accounts')) return [[{user_id:0}]];
  return db.execute(sql,args);
}};
const unowned = createDiscordBotStore({withDatabase: fn => fn(unownedDb), scope});
const selected = await unowned.account({discordId:'1'}, {esoAccount:'@RECIPIENT'});
assert.equal(selected.selectedAccount, '@recipient');
idempotency = null;
const unownedResult = await unowned.request({discordId:'1'}, {
  expectedRecipient:'@RECIPIENT', reference:'inventory:9', quantity:1, interactionId:'unowned',
});
assert.equal(unownedResult.request.recipient, '@recipient');
assert.equal(unownedResult.request.verification, 'provisional');

idempotency = null;
await assert.rejects(() => unowned.request({discordId:'1'}, {
  expectedRecipient:'@OldChoice', reference:'inventory:9', quantity:1, interactionId:'changed',
}), error => error.code === 'RECIPIENT_CHANGED' && error.statusCode === 409);
assert.ok(statements.some(s => s.sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'));
assert.ok(statements.some(s => s.sql === 'SELECT id FROM itemshare_shared_items WHERE id = ? FOR UPDATE'));
console.log('Discord claim policy, unowned accounts, canonical recipients and transaction tests passed');
