import assert from 'node:assert/strict';
import test from 'node:test';
import {createGuildSyncReader} from './lib/discord-bot-guildsync.js';

const env={ITEMSHARE_GUILDSYNC_READ_ENABLED:'true',ITEMSHARE_GUILDSYNC_READ_DATABASE:'guildsync_test',ITEMSHARE_GUILDSYNC_READ_USER:'itemshare_reader',ITEMSHARE_GUILDSYNC_READ_PLATFORM:'2',ITEMSHARE_GUILDSYNC_READ_WORLD:'NA Megaserver'};
const scope={esoGuildId:'1234',platform:2,worldName:'NA Megaserver'};
test('disabled source never opens GuildSync and provides no invented confirmed links',async()=>{
  const source=createGuildSyncReader({env:{},scope,connect:async()=>{throw Error('must not connect');}});
  assert.deepEqual(await source.confirmedAccounts('111111111111111111'),[]);
  assert.equal(await source.claimAllowed('111111111111111111','@test'),true);
});
test('optional GuildSync adapter only SELECTs, checks source guild binding, and normalizes confirmed ESO names',async()=>{
  const queries=[];
  const source=createGuildSyncReader({env,scope,connect:async()=>({execute:async(sql,args)=>{
    queries.push({sql,args});
    if(sql.includes('guildsync_settings'))return [[{value:'1234'}],[]];
    return [[{eso_account_name:'Tester'}],[]];
  },end:async()=>{}})});
  assert.deepEqual(await source.confirmedAccounts('111111111111111111'),[{esoAccount:'@tester'}]);
  assert(queries.every(q=>/^\s*SELECT/.test(q.sql)));
  assert(queries.some(q=>q.sql.includes("link_status = 'linked'")&&q.sql.includes('auto_link_blocked')&&q.sql.includes('in_roster')));
});
test('source outage or wrong guild cannot be silently converted into an unverified account',async()=>{
  const source=createGuildSyncReader({env,scope,connect:async()=>({execute:async()=>[[{value:'999'}],[]],end:async()=>{}})});
  await assert.rejects(source.confirmedAccounts('111111111111111111'),/guild/i);
  const offline=createGuildSyncReader({env,scope,connect:async()=>{throw Error('credentials and hostname must not escape');}});
  await assert.rejects(offline.confirmedAccounts('111111111111111111'),error=>error.statusCode===503&&!error.message.includes('credentials'));
});
test('claims are refused if blocked or linked to a different Discord member',async()=>{
  const source=createGuildSyncReader({env,scope,connect:async()=>({execute:async sql=>sql.includes('guildsync_settings')?[[{value:'1234'}],[]]:[[{found:1}],[]],end:async()=>{}})});
  assert.equal(await source.claimAllowed('111111111111111111','@someone'),false);
});

test('GuildSync source explicitly matches both installation platform and megaserver',()=>{
  assert.throws(()=>createGuildSyncReader({env:{...env,ITEMSHARE_GUILDSYNC_READ_PLATFORM:'1'},scope}),/PLATFORM and WORLD/);
  assert.throws(()=>createGuildSyncReader({env:{...env,ITEMSHARE_GUILDSYNC_READ_WORLD:'EU Megaserver'},scope}),/PLATFORM and WORLD/);
  assert.throws(()=>createGuildSyncReader({env:{...env,ITEMSHARE_GUILDSYNC_READ_WORLD:''},scope}),/PLATFORM and WORLD/);
});
