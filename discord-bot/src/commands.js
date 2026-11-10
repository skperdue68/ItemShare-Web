import { SlashCommandBuilder } from 'discord.js';
export const commands=[new SlashCommandBuilder().setName('items').setDescription('Experimental private ItemShare access').setDMPermission(false)
 .addSubcommand(c=>c.setName('browse').setDescription('Browse available items'))
 .addSubcommand(c=>c.setName('search').setDescription('Search available items').addStringOption(o=>o.setName('name').setDescription('Item name').setRequired(true).setMaxLength(100)))
 .addSubcommand(c=>c.setName('categories').setDescription('Browse categories'))
 .addSubcommand(c=>c.setName('account').setDescription('View or select ESO recipient').addStringOption(o=>o.setName('eso').setDescription('ESO @Account recipient').setMaxLength(100)))
 .addSubcommand(c=>c.setName('request').setDescription('Prepare an item request for confirmation').addStringOption(o=>o.setName('item').setDescription('Reference: inventory:123 or offer:123').setRequired(true).setMaxLength(80)).addIntegerOption(o=>o.setName('quantity').setDescription('Quantity').setMinValue(1).setMaxValue(999999)))
 .addSubcommand(c=>c.setName('requests').setDescription('Your request history'))
 .addSubcommand(c=>c.setName('review').setDescription('Officer recipient association review').addStringOption(o=>o.setName('action').setDescription('Review action').addChoices({name:'List',value:'list'},{name:'Approve',value:'approve'},{name:'Reject',value:'reject'})).addUserOption(o=>o.setName('user').setDescription('Discord member')).addStringOption(o=>o.setName('eso').setDescription('ESO account').setMaxLength(100)))
 .addSubcommand(c=>c.setName('help').setDescription('Commands and workflow')).toJSON()];
