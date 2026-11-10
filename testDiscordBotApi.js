import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { readDiscordBotConfig, createDiscordBotRouter } from './lib/discord-bot-api.js';

const env = {
  ITEMSHARE_DISCORD_ENABLED:'true', ITEMSHARE_BOT_TOKEN:'a'.repeat(40),
  ITEMSHARE_DISCORD_GUILD_ID:'111111111111111111', ITEMSHARE_ESO_GUILD_ID:'1234',
  ITEMSHARE_ESO_GUILD_NAME:'Test guild', ITEMSHARE_ESO_PLATFORM:'2', ITEMSHARE_ESO_WORLD:'NA Megaserver',
  ITEMSHARE_DISCORD_MEMBER_ROLE_IDS:'222222222222222222', ITEMSHARE_DISCORD_OFFICER_ROLE_IDS:'333333333333333333',
};
const actor = {discordId:'444444444444444444',username:'Tester',roleIds:['222222222222222222']};

test('feature is disabled by default and enabled configuration fails closed',()=>{
  assert.equal(readDiscordBotConfig({}).enabled,false);
  assert.throws(()=>readDiscordBotConfig({...env,ITEMSHARE_BOT_TOKEN:'short'}),/token/i);
  assert.throws(()=>readDiscordBotConfig({...env,ITEMSHARE_DISCORD_MEMBER_ROLE_IDS:''}),/role/i);
  assert.throws(()=>readDiscordBotConfig({...env,ITEMSHARE_ESO_PLATFORM:'0'}),/platform/i);
});

test('API authenticates and scopes every operation, isolates officers, and strips internal notification data',async()=>{
  const calls=[];const notifications=[];
  const store={
    browse:async(who,input)=>{calls.push({who,input});return {items:[],scope:{guildName:'Test guild'}};},
    review:async()=>({associations:[]}),
    request:async()=>({duplicate:false,request:{id:7,status:'pending'},internal:{secret:'not for Discord'}}),
  };
  const app=express();
  app.use('/api/discord/v1',createDiscordBotRouter({config:readDiscordBotConfig(env),store,onSubmitted:async data=>notifications.push(data)}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}/api/discord/v1`;
  async function send(operation,body={},token=env.ITEMSHARE_BOT_TOKEN){
    const response=await fetch(`${base}/${operation}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({actor,discordGuildId:env.ITEMSHARE_DISCORD_GUILD_ID,...body})});
    return {status:response.status,body:await response.json()};
  }
  try {
    assert.equal((await send('browse',{},'bad')).status,401);
    assert.equal((await send('browse',{discordGuildId:'999999999999999999'})).status,403);
    assert.equal((await send('browse',{actor:{...actor,roleIds:[]}})).status,403);
    assert.equal((await send('review')).status,403);
    assert.equal((await send('review',{actor:{...actor,roleIds:['333333333333333333']}})).status,200);
    assert.equal((await send('browse',{scope:{esoGuildId:'evil'},search:'briar'})).status,200);
    assert.equal(calls[0].input.scope,undefined,'the caller cannot override configured scope');
    assert.equal(calls[0].input.search,'briar');
    const request=await send('request',{reference:'inventory:1',quantity:1,interactionId:'555555555555555555'});
    assert.equal(request.status,200);assert.equal(request.body.internal,undefined);assert.equal(notifications.length,1);
    assert.equal((await send('unknown')).status,404);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('notification failure does not report a committed item request as failed',async()=>{
  const app=express();
  app.use(createDiscordBotRouter({config:readDiscordBotConfig(env),store:{request:async()=>({request:{id:8,status:'pending'},duplicate:false,internal:{}})},onSubmitted:async()=>{throw Error('mail offline');},logger:()=>{}}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/request`,{method:'POST',headers:{authorization:`Bearer ${env.ITEMSHARE_BOT_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({actor,discordGuildId:env.ITEMSHARE_DISCORD_GUILD_ID,reference:'inventory:1',quantity:1,interactionId:'555555555555555556'})});
    const result=await response.json();assert.equal(response.status,200);assert.equal(result.request.id,8);assert.equal(result.notificationPending,true);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
