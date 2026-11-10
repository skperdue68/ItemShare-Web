import { Client, GatewayIntentBits, Events } from 'discord.js';
import { config } from './config.js';
import { createApi } from './api.js';
import { createHandler } from './handler.js';
try {
 const env=config();const client=new Client({intents:[GatewayIntentBits.Guilds]});
 const handler=createHandler({guildId:env.DISCORD_GUILD_ID,api:createApi({url:env.ITEMSHARE_API_URL,token:env.ITEMSHARE_BOT_TOKEN})});
 client.on(Events.InteractionCreate,i=>{handler(i).catch(()=>console.error('Interaction response failed; no request retried.'));});
 client.once(Events.ClientReady,()=>console.log('Experimental ItemShare bot connected; commands respond privately.'));
 client.on(Events.Error,()=>console.error('Discord connection error. Check connection and application settings.'));
 await client.login(env.DISCORD_TOKEN);
}catch{console.error('Bot startup failed. Check required .env settings, Discord token and API URL. No credentials were logged.');process.exitCode=1;}
