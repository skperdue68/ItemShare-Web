import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi} from '../src/api.js';
test('API sends dedicated bearer and body with no redirect following',async()=>{let sent;const api=createApi({url:'https://example.test',token:'secret',fetchImpl:async(url,options)=>{sent={url,options};return {ok:true,json:async()=>({ok:true,items:[]})};}});await api('browse',{actor:{discordId:'123'}});assert.equal(sent.url,'https://example.test/api/discord/v1/browse');assert.equal(sent.options.headers.authorization,'Bearer secret');assert.equal(sent.options.redirect,'error');assert.equal(JSON.parse(sent.options.body).actor.discordId,'123');});
test('API refuses insecure remote URL',()=>assert.throws(()=>createApi({url:'http://example.com',token:'x'}),/HTTPS/));
test('API surfaces sanitized backend error and never retries',async()=>{let count=0;const api=createApi({url:'http://localhost:3000',token:'secret',fetchImpl:async()=>{count++;return {ok:false,status:403,json:async()=>({ok:false,error:'@everyone denied',code:'FORBIDDEN'})};}});await assert.rejects(api('request',{}),error=>error.publicMessage.includes('＠everyone denied'));assert.equal(count,1);});
