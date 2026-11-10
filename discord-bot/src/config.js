import 'dotenv/config';
export function config() {
 const names=['DISCORD_TOKEN','DISCORD_CLIENT_ID','DISCORD_GUILD_ID','ITEMSHARE_API_URL','ITEMSHARE_BOT_TOKEN'];
 const missing=names.filter(name=>!process.env[name]?.trim());if(missing.length)throw new Error(`Missing environment settings: ${missing.join(', ')}. Copy .env.example to .env and configure the experimental installation.`);
 for(const name of ['DISCORD_CLIENT_ID','DISCORD_GUILD_ID'])if(!/^\d{17,20}$/.test(process.env[name]))throw new Error(`${name} must be a Discord snowflake ID.`);
 return Object.fromEntries(names.map(name=>[name,process.env[name].trim()]));
}
