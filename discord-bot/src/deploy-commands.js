import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commands } from './commands.js';
try {const env=config();await new REST({version:'10'}).setToken(env.DISCORD_TOKEN).put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID,env.DISCORD_GUILD_ID),{body:commands});console.log('Registered /items only in the configured development guild.');}catch{console.error('Command registration failed. Check .env, application ID, guild ID, token and application installation.');process.exitCode=1;}
