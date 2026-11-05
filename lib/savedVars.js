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

/**
 * The account-wide guild registry, when this scope carries one.
 *
 * The addon writes guild data once, keyed by guild id, and expects names to be resolved
 * from it: items carry no guild fields and characters carry ids only.
 *
 * Guarded rather than trusted: a table that is not id -> name is not a registry, and
 * reading one as if it were would invent guild ids.
 */
function guildRegistry(scope) {
  if (!isPlainTable(scope.guilds)) {
    return null;
  }

  const entries = Object.entries(scope.guilds);

  if (entries.length === 0) {
    return null;
  }

  const isRegistry = entries.every(
    ([guildId, guildName]) => /^\d+$/.test(guildId) && typeof guildName === 'string'
  );

  return isRegistry ? scope.guilds : null;
}

/** The registry's name for one guild, or '' when it has none. */
function registryName(registry, guildId) {
  return registry ? text(registry[String(integer(guildId))]) : '';
}

function collectScopeGuilds(scope, targets) {
  const add = (guildId, guildName) => {
    for (const guilds of targets) {
      collectGuild(guilds, guildId, guildName);
    }
  };

  const registry = guildRegistry(scope);

  // Every registered guild is recorded, whether or not an item names it: a name has to
  // be there for a row to point at, and the upload's guild count is the size of this map.
  if (registry) {
    for (const [guildId, guildName] of Object.entries(registry)) {
      add(guildId, guildName);
    }
  }

  if (isPlainTable(scope.characterGuilds)) {
    for (const character of Object.values(scope.characterGuilds)) {
      if (!isPlainTable(character)) continue;
      // Ids only: the names are in the registry.
      for (const guildId of listOf(character.guildIds)) {
        add(guildId, registryName(registry, guildId));
      }
    }
  }
}

/**
 * The guilds one character is in, from its snapshot, or null when this file has no
 * snapshot for that character. In v3 the items carry no guild fields at all, so this is
 * where their guilds come from now.
 */
function characterGuildIds(scope, characterName) {
  if (!isPlainTable(scope.characterGuilds) || !characterName) {
    return null;
  }

  const snapshot = scope.characterGuilds[characterName];

  if (!isPlainTable(snapshot)) {
    return null;
  }

  const ids = listOf(snapshot.guildIds).map(integer).filter((id) => id > 0);

  return ids.length > 0 ? ids : null;
}

/**
 * Which guilds see this row. An item carries no guild fields at all, so the character it
 * came from decides; a character the file has no snapshot for falls back to the
 * account's own membership, so an item is never offered to nobody.
 */
function guildIdsFor(characterName, resolveGuilds) {
  const resolved = resolveGuilds ? resolveGuilds(characterName) : null;

  return (resolved || []).filter((id) => id > 0);
}

/**
 * The name a row is keyed by. It is the table key today; the addon will drop both the key
 * and `itemKey`, and the link plus the location it was found in is the pair that still
 * identifies a row without them.
 */
function itemKeyFrom(entry, fallbackKey) {
  const explicit = text(entry.itemKey) || text(fallbackKey);

  if (explicit) {
    return explicit;
  }

  const link = text(entry.itemLink);
  const location = text(entry.locationKey);

  return link && location ? `${link}||${location}` : link;
}

/**
 * The shareable number. An explicit `count` always wins; when the addon stops writing it,
 * what the bag holds minus what the owner keeps back is the same number.
 */
function itemCountFrom(entry) {
  const explicit = entry.count;

  if (explicit !== undefined && explicit !== null && explicit !== '') {
    return integer(explicit);
  }

  const held = Math.max(0, integer(entry.heldCount));
  const reserve = Math.max(0, integer(entry.reserve));

  return Math.max(0, held - reserve);
}

function buildItem({ accountName, scopeName, itemKey, entry, resolveGuilds }) {
  const resolvedAccount = text(entry.accountName) || accountName;
  const characterName = text(entry.characterName)
    || (scopeName.startsWith('$') || scopeName === '' ? 'AccountWide' : scopeName);
  const guildIds = guildIdsFor(characterName, resolveGuilds);

  return {
    accountName: resolvedAccount,
    characterName,
    itemKey: itemKeyFrom(entry, itemKey),
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
    itemCount: itemCountFrom(entry),
    // What the bag held and what the owner keeps back. itemCount stays the shareable
    // number, so every free/held calculation is unchanged; these explain it.
    heldQuantity: integer(entry.heldCount),
    reserveQuantity: integer(entry.reserve),
    firstDumpedAt: integer(entry.firstDumpedAt),
    lastDumpedAt: integer(entry.lastDumpedAt),
    guildIds,
    // Not stored. Where the table put this entry, kept so useFileAccounts can correct
    // an accountName that no longer names an account in the file.
    pathAccount: accountName,
  };
}

function buildAlwaysShare({ accountName, scopeName, itemKey, entry, resolveGuilds }) {
  const resolvedAccount = text(entry.accountName) || accountName;
  const characterName = text(entry.characterName)
    || (scopeName.startsWith('$') || scopeName === '' ? 'AccountWide' : scopeName);
  const guildIds = guildIdsFor(characterName, resolveGuilds);

  return {
    accountName: resolvedAccount,
    characterName,
    itemKey: itemKeyFrom(entry, itemKey),
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
    pathAccount: accountName,
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

    // An item names no guilds, only the character it came from, so the lookup happens
    // here where both the character snapshots and the account's membership are in hand.
    // The account's membership is still being built at this point, which is why the
    // registry is collected first.
    const resolveGuilds = (characterName) =>
      characterGuildIds(node, characterName) || [...guildMapFor(pathAccount).keys()];

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
        items.push(buildItem({ accountName, scopeName, itemKey: entryKey, entry, resolveGuilds }));
      }
    }

    const alwaysKey = ALWAYS_TABLE_KEYS.find((key) => isPlainTable(node[key]));
    if (alwaysKey) {
      const accountName = pathAccount;
      const scopeName = path[path.length - 1] ?? '';
      accounts.add(accountName);

      for (const [entryKey, entry] of Object.entries(node[alwaysKey])) {
        if (!isPlainTable(entry)) continue;
        alwaysShare.push(
          buildAlwaysShare({ accountName, scopeName, itemKey: entryKey, entry, resolveGuilds })
        );
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (ITEM_TABLE_KEYS.includes(key) || ALWAYS_TABLE_KEYS.includes(key)) continue;
      walk(value, [...path, key]);
    }
  };

  walk(root, []);

  // The table an entry sits under is what owns it. The addon also copies the account
  // name into every entry it dumps, and that copy goes stale the moment a saved
  // variables file is copied to another account: the entries still say @old-name while
  // they now sit under @new-name. Trusting the copy filed them under an account the file
  // does not contain, so the upload recorded no items at all for any account in it. Only
  // a name that really is one of this file's accounts may override where the table put
  // the entry; anything else follows the table.
  for (const row of [...items, ...alwaysShare]) {
    if (!accounts.has(row.accountName)) {
      row.accountName = row.pathAccount;
    }
    delete row.pathAccount;
  }

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
