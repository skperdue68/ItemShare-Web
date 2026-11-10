import mysql from 'mysql2/promise';

const canonical = value => `@${String(value || '').trim().replace(/^@/,'').toLowerCase()}`;
const unavailable = () => Object.assign(new Error('The read-only GuildSync identity source is unavailable or belongs to another guild. Try again later or ask an officer.'),{statusCode:503,code:'identity_unavailable'});

/** No GuildSync schema initialization, settings updates, or identity writes occur here. */
export function createGuildSyncReader({env=process.env,scope,connect=mysql.createConnection}) {
  if (String(env.ITEMSHARE_GUILDSYNC_READ_ENABLED || '').toLowerCase() !== 'true') {
    return {confirmedAccounts:async()=>[],claimAllowed:async()=>true};
  }
  const database = String(env.ITEMSHARE_GUILDSYNC_READ_DATABASE || '').trim();
  const user = String(env.ITEMSHARE_GUILDSYNC_READ_USER || '').trim();
  // GuildSync stores the ESO guild id but does not attest platform/megaserver here.
  // Explicit operator mapping is required instead of guessing the source world.
  const sourcePlatform = Number(env.ITEMSHARE_GUILDSYNC_READ_PLATFORM);
  const sourceWorld = String(env.ITEMSHARE_GUILDSYNC_READ_WORLD || '').trim();
  if (sourcePlatform !== Number(scope.platform) || sourceWorld !== scope.worldName) {
    throw new Error('Declare the trusted GuildSync source PLATFORM and WORLD; they must match the ItemShare installation.');
  }
  if (!/^[A-Za-z0-9_]+$/.test(database) || !user) throw new Error('Configure a dedicated GuildSync read-only database and user for ITEMSHARE_GUILDSYNC_READ_ENABLED.');
  const port = Number(env.ITEMSHARE_GUILDSYNC_READ_PORT || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid ITEMSHARE_GUILDSYNC_READ_PORT.');
  const settings = {
    host:String(env.ITEMSHARE_GUILDSYNC_READ_HOST || '127.0.0.1'),port,database,user,
    password:String(env.ITEMSHARE_GUILDSYNC_READ_PASSWORD || ''),connectTimeout:5000,
    ...(String(env.ITEMSHARE_GUILDSYNC_READ_TLS || '').toLowerCase()==='true'?{ssl:{rejectUnauthorized:true}}:{}),
  };
  async function read(action) {
    let connection;
    try {
      connection = await connect(settings);
      const [bound] = await connection.execute('SELECT value FROM guildsync_settings WHERE setting_key = ? LIMIT 1',['eso_guild_id']);
      if (String(bound[0]?.value || '').replace(/^"|"$/g,'') !== String(scope.esoGuildId)) throw unavailable();
      return await action(connection);
    } catch { throw unavailable(); }
    finally {if(connection) await connection.end().catch(()=>{});}
  }
  return {
    async confirmedAccounts(discordId) {
      return read(async connection=>{
        const [rows] = await connection.execute(
          `SELECT DISTINCT l.eso_account_name FROM guildsync_member_links l
             JOIN guildsync_roster_members r
               ON LOWER(TRIM(LEADING '@' FROM r.account_name)) = LOWER(TRIM(LEADING '@' FROM l.eso_account_name))
            WHERE l.discord_user_id = ? AND l.link_status = 'linked'
              AND l.auto_link_blocked = 0 AND r.in_roster = 1
            ORDER BY l.eso_account_name`,[String(discordId)]
        );
        return rows.map(row=>({esoAccount:canonical(row.eso_account_name)}));
      });
    },
    async claimAllowed(discordId,esoAccount) {
      return read(async connection=>{
        const [conflicts] = await connection.execute(
          `SELECT 1 AS found FROM guildsync_member_links
            WHERE LOWER(TRIM(LEADING '@' FROM eso_account_name)) = ?
              AND ((discord_user_id <> ? AND link_status = 'linked')
                OR (discord_user_id = ? AND (auto_link_blocked = 1 OR link_status = 'blocked')))
            LIMIT 1`,[canonical(esoAccount).slice(1),String(discordId),String(discordId)]
        );
        return conflicts.length===0;
      });
    },
  };
}
