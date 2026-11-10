import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

const snowflake = value => /^\d{16,22}$/.test(String(value || ''));
const enabled = value => String(value || '').toLowerCase() === 'true';
const roleList = value => [...new Set(String(value || '').split(',').map(v=>v.trim()).filter(Boolean))];

export function readDiscordBotConfig(env = process.env) {
  if (!enabled(env.ITEMSHARE_DISCORD_ENABLED)) return { enabled: false };
  const token = String(env.ITEMSHARE_BOT_TOKEN || '').trim();
  if (token.length < 32) throw new Error('ITEMSHARE_BOT_TOKEN must be at least 32 characters.');
  const discordGuildId = String(env.ITEMSHARE_DISCORD_GUILD_ID || '').trim();
  if (!snowflake(discordGuildId)) throw new Error('ITEMSHARE_DISCORD_GUILD_ID must name the test Discord server.');
  const esoGuildId = String(env.ITEMSHARE_ESO_GUILD_ID || '').trim();
  if (!/^\d{1,20}$/.test(esoGuildId) || /^0+$/.test(esoGuildId)) throw new Error('ITEMSHARE_ESO_GUILD_ID is required.');
  const platform = Number(env.ITEMSHARE_ESO_PLATFORM || 2);
  if (!Number.isSafeInteger(platform) || platform <= 0 || platform > 65535) throw new Error('ITEMSHARE_ESO_PLATFORM must be a valid positive platform number.');
  const worldName = String(env.ITEMSHARE_ESO_WORLD || '').trim();
  if (!worldName || worldName.length > 64) throw new Error('ITEMSHARE_ESO_WORLD is required (for example NA Megaserver).');
  const memberRoles = roleList(env.ITEMSHARE_DISCORD_MEMBER_ROLE_IDS);
  const officerRoles = roleList(env.ITEMSHARE_DISCORD_OFFICER_ROLE_IDS);
  if (!memberRoles.length || [...memberRoles,...officerRoles].some(id=>!snowflake(id))) throw new Error('Configure valid member role IDs; officer role IDs are optional.');
  const maxQuantity = Number(env.ITEMSHARE_DISCORD_MAX_QUANTITY || 20);
  if (!Number.isSafeInteger(maxQuantity) || maxQuantity < 1 || maxQuantity > 20) throw new Error('ITEMSHARE_DISCORD_MAX_QUANTITY must be between 1 and 20.');
  return {
    enabled: true, token, memberRoles, officerRoles,
    scope: {
      installationId: createHash('sha256').update(`${discordGuildId}:${esoGuildId}:${platform}:${worldName}`).digest('hex'),
      discordGuildId, esoGuildId, platform, worldName,
      guildName: String(env.ITEMSHARE_ESO_GUILD_NAME || 'ItemShare guild').trim().slice(0,255),
      allowProvisional: env.ITEMSHARE_DISCORD_ALLOW_PROVISIONAL === undefined || enabled(env.ITEMSHARE_DISCORD_ALLOW_PROVISIONAL),
      maxQuantity,
    },
  };
}

function tokenMatches(received, expected) {
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(received), digest(expected));
}

const operations = {
  browse:['search','category','page'], categories:[], identity:[], account:['esoAccount'],
  item:['reference'], request:['reference','quantity','interactionId','expectedRecipient'], requests:['page'],
  review:['action','discordId','esoAccount'],
};

export function createDiscordBotRouter({ config, store, onSubmitted = async()=>{}, logger = console.warn }) {
  const router = express.Router();
  const rate = new Map();
  router.use((req,res,next)=>{
    res.set('Cache-Control','no-store');
    if (!config.enabled) return res.status(404).json({ok:false,error:'Discord integration is disabled.',code:'disabled'});
    const authorization = String(req.headers.authorization || '');
    if (!authorization.startsWith('Bearer ') || !tokenMatches(authorization.slice(7),config.token)) {
      return res.status(401).json({ok:false,error:'Invalid bot credentials.',code:'unauthorized'});
    }
    next();
  });
  router.use(express.json({limit:'16kb',strict:true}));
  router.post('/:operation',async(req,res)=>{
    const operation = req.params.operation;
    if (!Object.hasOwn(operations,operation) || typeof store?.[operation] !== 'function') return res.status(404).json({ok:false,error:'Unknown bot operation.',code:'not_found'});
    const body = req.body || {};
    if (body.discordGuildId !== config.scope.discordGuildId) return res.status(403).json({ok:false,error:'This bot is not configured for that Discord server.',code:'wrong_guild'});
    const supplied = body.actor;
    if (!supplied || !snowflake(supplied.discordId) || !Array.isArray(supplied.roleIds) || supplied.roleIds.length > 250 || supplied.roleIds.some(id=>!snowflake(id))) {
      return res.status(400).json({ok:false,error:'The interaction must identify the Discord member and roles.',code:'invalid_actor'});
    }
    const actor = {discordId:String(supplied.discordId),username:String(supplied.username || 'Discord member').slice(0,96),roleIds:[...new Set(supplied.roleIds)]};
    const officer = actor.roleIds.some(id=>config.officerRoles.includes(id));
    if ((!officer && !actor.roleIds.some(id=>config.memberRoles.includes(id))) || operation==='review' && !officer) {
      return res.status(403).json({ok:false,error:operation==='review'?'An ItemShare officer role is required.':'A configured ItemShare member role is required.',code:'role_required'});
    }
    const now = Date.now();
    for (const [id,entry] of rate) if(entry.until<=now) rate.delete(id);
    const entry = rate.get(actor.discordId) || {until:now+60000,count:0};
    entry.count++;rate.set(actor.discordId,entry);
    if (entry.count>90) return res.status(429).json({ok:false,error:'Please wait a minute before trying again.',code:'rate_limited'});
    const input = Object.fromEntries(operations[operation].filter(key=>Object.hasOwn(body,key)).map(key=>[key,body[key]]));
    try {
      const result = await store[operation](actor,input);
      const {internal,...publicResult} = result || {};
      let notificationPending = false;
      if (operation==='request' && !result.duplicate && internal) {
        try { await onSubmitted(internal); }
        catch { notificationPending=true;logger('Discord request was recorded, but a notification failed.'); }
      }
      res.json({ok:true,...publicResult,...(notificationPending?{notificationPending:true}:{})});
    } catch (error) {
      const status = Number(error.statusCode || error.status);
      const safeStatus = Number.isInteger(status) && status>=400 && status<500 ? status : 500;
      if (safeStatus===500) logger('Discord bot operation failed. Check database configuration and service logs.');
      res.status(safeStatus).json({ok:false,error:safeStatus===500?'ItemShare could not complete that action. Please try again shortly.':error.message,code:safeStatus===500?'service_error':String(error.code || 'invalid_request')});
    }
  });
  router.use((error,req,res,next)=>{
    if (res.headersSent) return next(error);
    res.status(error.type==='entity.too.large'?413:400).json({ok:false,error:'Send a valid JSON interaction body of at most 16 KB.',code:'invalid_json'});
  });
  return router;
}
