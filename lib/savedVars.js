// Turns the parsed ItemShareSavedVars table into flat rows the database can
// store. ESO wraps saved variables in a profile key, so the items table can sit
// several levels down:
//
//   ItemShareSavedVars = { ["Default"] = { ["@Account"] = { ["$AccountWide"] = { ["sharedItems"] = { ... } } } } }
//
// Older files used "dumpedItems" instead of "sharedItems", so both are accepted.

import { isPlainTable, parseLuaAssignment } from './luaTable.js';

const ITEM_TABLE_KEYS = ['sharedItems', 'dumpedItems'];
// Standing offers ("if I ever have this again, I will offer it") are stored apart
// from the inventory list on purpose: they carry no count and no location, so
// nothing that prunes the inventory list can remove them.
const ALWAYS_TABLE_KEYS = ['alwaysShare'];

function text(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return String(value);
}

function integer(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

// Older addon versions did not save the item id separately; the link still has it.
function itemIdFromLink(itemLink) {
  const match = String(itemLink || '').match(/item:(\d+)/);
  return match ? integer(match[1]) : 0;
}

// The addon stores each raw getter result as a packed table, for example
// esoDetails.GetItemLinkSetInfo = { true, "Briarheart", 5, 3, 5 }. Turn that
// into plain JSON so detail the site does not render yet survives the upload.
function plainValue(value) {
  if (!isPlainTable(value)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    return null;
  }

  const keys = Object.keys(value);
  const isList = keys.length > 0 && keys.every((key) => /^\d+$/.test(key));
  const ordered = keys.sort((a, b) => (isList ? Number(a) - Number(b) : a.localeCompare(b)));

  if (isList) {
    return ordered.map((key) => plainValue(value[key]));
  }

  const result = {};
  for (const key of ordered) {
    result[key] = plainValue(value[key]);
  }
  return result;
}

function esoDetailsJson(details) {
  const plain = plainValue(details);
  if (!plain || typeof plain !== 'object' || Array.isArray(plain)) {
    return null;
  }
  return Object.keys(plain).length ? JSON.stringify(plain) : null;
}

function listOf(table) {
  if (!isPlainTable(table)) {
    return [];
  }
  return Object.keys(table)
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => table[key]);
}

function collectGuild(guilds, guildId, guildName) {
  const id = integer(guildId);
  if (id <= 0) {
    return;
  }
  const name = text(guildName);
  if (!guilds.has(id) || (guilds.get(id) === '' && name !== '')) {
    guilds.set(id, name);
  }
}

function collectScopeGuilds(scope, targets) {
  const add = (guildId, guildName) => {
    for (const guilds of targets) {
      collectGuild(guilds, guildId, guildName);
    }
  };

  if (isPlainTable(scope.knownGuilds)) {
    for (const [guildId, guildName] of Object.entries(scope.knownGuilds)) {
      add(guildId, guildName);
    }
  }

  if (isPlainTable(scope.characterGuilds)) {
    for (const character of Object.values(scope.characterGuilds)) {
      if (!isPlainTable(character)) continue;
      for (const guildId of listOf(character.guildIds)) {
        add(guildId, '');
      }
      for (const detail of listOf(character.guilds)) {
        if (isPlainTable(detail)) {
          add(detail.guildId, detail.guildName);
        }
      }
    }
  }
}

function buildItem({ accountName, scopeName, itemKey, entry, guilds }) {
  const guildIds = listOf(entry.guildIds).map(integer).filter((id) => id > 0);
  const guildNames = listOf(entry.guildNames).map(text);
  guildIds.forEach((guildId, index) => collectGuild(guilds, guildId, guildNames[index] ?? ''));

  const resolvedAccount = text(entry.accountName) || accountName;
  const characterName = text(entry.characterName)
    || (scopeName.startsWith('$') || scopeName === '' ? 'AccountWide' : scopeName);

  return {
    accountName: resolvedAccount,
    characterName,
    itemKey: text(itemKey),
    itemLink: text(entry.itemLink),
    itemId: integer(entry.itemId) || itemIdFromLink(entry.itemLink),
    icon: text(entry.icon),
    itemName: text(entry.itemName) || text(itemKey),
    itemType: integer(entry.itemType),
    itemTypeName: text(entry.itemTypeName),
    quality: integer(entry.quality),
    qualityName: text(entry.qualityName),
    trait: text(entry.trait),
    traitType: text(entry.traitType),
    apparelSlot: text(entry.apparelSlot),
    equipType: text(entry.equipType),
    apparelWeight: text(entry.apparelWeight),
    armorType: text(entry.armorType),
    weaponType: text(entry.weaponType),
    weaponHandedness: text(entry.weaponHandedness),
    furnitureDataId: integer(entry.furnitureDataId),
    setName: text(entry.setName),
    enchantName: text(entry.enchantName),
    styleName: text(entry.styleName),
    requiredLevel: integer(entry.requiredLevel),
    requiredCp: integer(entry.requiredCp),
    flavorText: text(entry.flavorText),
    esoData: esoDetailsJson(entry.esoDetails),
    locationKey: text(entry.locationKey),
    locationLabel: text(entry.sharedFrom),
    itemCount: integer(entry.count),
    // What the bag held and what the owner keeps back. itemCount stays the shareable
    // number, so every free/held calculation is unchanged; these explain it.
    heldQuantity: integer(entry.heldCount),
    reserveQuantity: integer(entry.reserve),
    firstDumpedAt: integer(entry.firstDumpedAt),
    lastDumpedAt: integer(entry.lastDumpedAt),
    guildIds,
  };
}

function buildAlwaysShare({ accountName, scopeName, itemKey, entry, guilds }) {
  const guildIds = listOf(entry.guildIds).map(integer).filter((id) => id > 0);
  const guildNames = listOf(entry.guildNames).map(text);
  guildIds.forEach((guildId, index) => collectGuild(guilds, guildId, guildNames[index] ?? ''));

  const resolvedAccount = text(entry.accountName) || accountName;
  const characterName = text(entry.characterName)
    || (scopeName.startsWith('$') || scopeName === '' ? 'AccountWide' : scopeName);

  return {
    accountName: resolvedAccount,
    characterName,
    itemKey: text(entry.itemKey) || text(itemKey),
    itemLink: text(entry.itemLink),
    itemId: integer(entry.itemId) || itemIdFromLink(entry.itemLink),
    icon: text(entry.icon),
    itemName: text(entry.itemName) || text(itemKey),
    itemType: integer(entry.itemType),
    itemTypeName: text(entry.itemTypeName),
    quality: integer(entry.quality),
    qualityName: text(entry.qualityName),
    trait: text(entry.trait),
    traitType: text(entry.traitType),
    apparelSlot: text(entry.apparelSlot),
    equipType: text(entry.equipType),
    apparelWeight: text(entry.apparelWeight),
    armorType: text(entry.armorType),
    weaponType: text(entry.weaponType),
    weaponHandedness: text(entry.weaponHandedness),
    furnitureDataId: integer(entry.furnitureDataId),
    setName: text(entry.setName),
    enchantName: text(entry.enchantName),
    styleName: text(entry.styleName),
    requiredLevel: integer(entry.requiredLevel),
    requiredCp: integer(entry.requiredCp),
    flavorText: text(entry.flavorText),
    esoData: esoDetailsJson(entry.esoDetails),
    firstAddedAt: integer(entry.firstAddedAt),
    lastUpdatedAt: integer(entry.lastUpdatedAt),
    // A standing offer has no count of its own; the reserve is still worth recording
    // because it is why the offer has nothing to hand over right now.
    heldQuantity: integer(entry.heldCount),
    reserveQuantity: integer(entry.reserve),
    guildIds,
  };
}

function accountFromPath(path) {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    if (path[index].startsWith('@')) {
      return path[index];
    }
  }
  return path[0] ?? 'Unknown';
}

/**
 * @param {string} fileText raw contents of ItemShareSavedVars.lua
 * @returns {{
 *   guilds: Map<number, string>,
 *   accountGuilds: Map<string, Map<number, string>>,
 *   items: object[],
 *   alwaysShare: object[],
 *   addonVersions: Map<string, string>,
 *   accounts: string[],
 *   accountCount: number
 * }}
 */
export function extractShareData(fileText) {
  const root = parseLuaAssignment(fileText, 'ItemShareSavedVars');
  const guilds = new Map();
  const accountGuilds = new Map();
  const items = [];
  const alwaysShare = [];
  // 1.8.1+ writes the addon version it ran as into each account scope, so an
  // upload can say which addon produced it instead of guessing from missing
  // fields.
  const addonVersions = new Map();
  const accounts = new Set();

  // Guild membership is tracked twice: once for the whole file and once per ESO
  // account, so a file holding several accounts does not give every account the
  // guilds of the others.
  const guildMapFor = (accountName) => {
    if (!accountGuilds.has(accountName)) {
      accountGuilds.set(accountName, new Map());
    }
    return accountGuilds.get(accountName);
  };

  const walk = (node, path) => {
    if (!isPlainTable(node)) {
      return;
    }

    const pathAccount = accountFromPath(path);
    collectScopeGuilds(node, [guilds, guildMapFor(pathAccount)]);

    if (typeof node.addonVersion === 'string' && node.addonVersion !== '') {
      addonVersions.set(pathAccount, node.addonVersion);
    }

    const itemKey = ITEM_TABLE_KEYS.find((key) => isPlainTable(node[key]));
    if (itemKey) {
      const accountName = pathAccount;
      const scopeName = path[path.length - 1] ?? '';
      accounts.add(accountName);

      for (const [entryKey, entry] of Object.entries(node[itemKey])) {
        if (!isPlainTable(entry)) continue;
        items.push(buildItem({ accountName, scopeName, itemKey: entryKey, entry, guilds }));
      }
    }

    const alwaysKey = ALWAYS_TABLE_KEYS.find((key) => isPlainTable(node[key]));
    if (alwaysKey) {
      const accountName = pathAccount;
      const scopeName = path[path.length - 1] ?? '';
      accounts.add(accountName);

      for (const [entryKey, entry] of Object.entries(node[alwaysKey])) {
        if (!isPlainTable(entry)) continue;
        alwaysShare.push(buildAlwaysShare({ accountName, scopeName, itemKey: entryKey, entry, guilds }));
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (ITEM_TABLE_KEYS.includes(key) || ALWAYS_TABLE_KEYS.includes(key)) continue;
      walk(value, [...path, key]);
    }
  };

  walk(root, []);

  // An entry can name guilds the character snapshot never listed; keep the
  // account's membership consistent so an owner always sees their own share.
  for (const item of items) {
    const memberOf = guildMapFor(item.accountName);
    for (const guildId of item.guildIds) {
      if (!memberOf.has(guildId)) {
        memberOf.set(guildId, guilds.get(guildId) ?? '');
      }
    }
  }

  // A standing offer is equally useless if the guild it is offered to vanishes
  // from the membership list, so it gets the same treatment.
  for (const offered of alwaysShare) {
    const memberOf = guildMapFor(offered.accountName);
    for (const guildId of offered.guildIds) {
      if (!memberOf.has(guildId)) {
        memberOf.set(guildId, guilds.get(guildId) ?? '');
      }
    }
  }

  // Drop the wrapper keys (profile names) visited while walking the file.
  for (const accountName of [...accountGuilds.keys()]) {
    if (!accounts.has(accountName)) {
      accountGuilds.delete(accountName);
    }
  }

  return {
    guilds,
    accountGuilds,
    items,
    alwaysShare,
    addonVersions,
    accounts: [...accounts],
    accountCount: accounts.size,
  };
}
