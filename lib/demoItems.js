// The catalogue of fake items the demo account shares.
//
// It lives here rather than in seedDemo.js because two things need it: the operator
// script that drops a fake guildmate into real guilds, and the Demo sign-in, which
// shows the same kind of items to somebody who has never uploaded a file. The shapes
// are the ones an upload writes, so everything downstream - filters, grouping,
// availability, the request dialog - treats them like any other shared item.

export const DEMO_ACCOUNT = '@DemoTrader';
export const DEMO_CHARACTER = 'Wears-Too-Much';

/**
 * How long a demo owner keeps an item shared, in days.
 *
 * The demo exists to show what the site does, and one of the things it does is flag a row
 * the owner has kept shared for longer than their own `expireDays`. The starter ages in
 * lib/itemAges.js run from months old down to a few hours, so a window of 30 days lands
 * between them: the oldest rows carry the red **LAST CHANCE** pill and the newest ones do
 * not, which is the mix the flag is for. A window long enough to flag nothing, or short
 * enough to flag everything, would show the feature without explaining it.
 */
export const DEMO_EXPIRE_DAYS = 30;

export const ITEMS = [
  {
    itemId: 76430,
    name: 'Briarheart Greatsword',
    type: 1,
    typeName: 'Weapon',
    quality: 4,
    qualityName: 'Legendary',
    trait: 'Sharpened',
    set: 'Briarheart',
    weapon: 'Greatsword',
    level: 50,
    cp: 160,
    enchant: 'Glyph of Increase Physical Harm',
    style: 'Breton',
    location: 'Inventory (Wears-Too-Much)',
    count: 1,
  },
  {
    itemId: 97228,
    name: "Mother's Sorrow Inferno Staff",
    type: 1,
    typeName: 'Weapon',
    quality: 3,
    qualityName: 'Epic',
    trait: 'Powered',
    set: "Mother's Sorrow",
    weapon: 'Inferno Staff',
    level: 50,
    cp: 160,
    enchant: 'Glyph of Increase Magical Harm',
    style: 'Dunmer',
    location: 'Bank',
    count: 1,
  },
  {
    itemId: 45723,
    name: "Hunding's Rage Cuirass",
    type: 2,
    typeName: 'Apparel',
    quality: 3,
    qualityName: 'Epic',
    trait: 'Impenetrable',
    set: "Hunding's Rage",
    slot: 'Chest',
    level: 50,
    cp: 160,
    enchant: 'Glyph of Prismatic Defense',
    style: 'Nord',
    location: 'Bank',
    count: 1,
  },
  {
    itemId: 15774,
    name: 'Ring of the Twice-Born Star',
    type: 3,
    typeName: 'Jewelry',
    quality: 4,
    qualityName: 'Legendary',
    trait: 'Arcane',
    set: 'Twice-Born Star',
    slot: 'Ring',
    level: 50,
    cp: 160,
    enchant: 'Glyph of Increase Magical Harm',
    style: 'Redguard',
    location: 'Inventory (Wears-Too-Much)',
    count: 1,
  },
  {
    itemId: 44868,
    name: 'Necklace of the Seducer',
    type: 3,
    typeName: 'Jewelry',
    quality: 3,
    qualityName: 'Epic',
    trait: 'Arcane',
    set: 'The Seducer',
    slot: 'Neck',
    level: 50,
    cp: 160,
    enchant: 'Glyph of Magicka Recovery',
    style: 'Altmer',
    location: 'Inventory (Wears-Too-Much)',
    count: 1,
  },
  {
    itemId: 64681,
    name: 'Crown Mimic Stone',
    type: 6,
    typeName: 'Consumable',
    quality: 4,
    qualityName: 'Legendary',
    location: 'Bank',
    count: 5,
  },
  {
    itemId: 54187,
    name: 'Dwemer Frame',
    type: 5,
    typeName: 'Material',
    quality: 2,
    qualityName: 'Superior',
    location: 'Bank',
    count: 12,
  },
  {
    itemId: 120591,
    name: 'Alinor Bookshelf, Grand',
    type: 8,
    typeName: 'Furnishing',
    quality: 1,
    qualityName: 'Fine',
    location: 'Furnishing Vault (Hall of the Lunar Champion)',
    count: 1,
  },
  {
    itemId: 135279,
    name: 'Crafting Motif 26: Daggerfall Covenant Swords',
    type: 9,
    typeName: 'Style',
    quality: 3,
    qualityName: 'Epic',
    location: 'Furnishing Vault (Hall of the Lunar Champion)',
    count: 1,
  },
];

export const OFFERS = [
  {
    itemId: 76431,
    name: 'Briarheart Dagger',
    type: 1,
    typeName: 'Weapon',
    quality: 4,
    qualityName: 'Legendary',
    trait: 'Precise',
    set: 'Briarheart',
    level: 50,
    cp: 160,
    enchant: 'Glyph of Increase Physical Harm',
    style: 'Breton',
  },
  {
    itemId: 64705,
    name: 'Aetherial Ambrosia',
    type: 6,
    typeName: 'Consumable',
    quality: 4,
    qualityName: 'Legendary',
  },
  {
    itemId: 60213,
    name: 'Perfect Roe',
    type: 5,
    typeName: 'Material',
    quality: 4,
    qualityName: 'Legendary',
  },
];

export function itemLinkFor(itemId) {
  return `|H0:item:${itemId}:363:50:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0|h|h`;
}

/**
 * One shared item in the shape the upload path writes.
 *
 * `accountName` and `characterName` are arguments because the demo sign-in shares from
 * its own account, so it can never collide with the @DemoTrader an operator seeded into
 * real guilds.
 */
export function buildItem(spec, index, guildIds, { accountName = DEMO_ACCOUNT, characterName = DEMO_CHARACTER } = {}) {
  const link = itemLinkFor(spec.itemId);
  const seconds = Math.trunc(Date.now() / 1000) - index * 1800;

  return {
    accountName,
    characterName,
    itemKey: `${link}||demo:${index}`,
    itemLink: link,
    itemId: spec.itemId,
    icon: '',
    itemName: spec.name,
    itemType: spec.type,
    itemTypeName: spec.typeName,
    quality: spec.quality,
    qualityName: spec.qualityName,
    trait: spec.trait || '',
    traitType: '',
    apparelSlot: spec.slot || '',
    equipType: '',
    apparelWeight: '',
    armorType: '',
    weaponType: spec.weapon || '',
    weaponHandedness: '',
    setName: spec.set || '',
    // The fields the list reads: ESO gates gear by level or by champion points, and the
    // enchanting and the style are half of why somebody wants the piece. A spec that leaves
    // one out - a material has no level, no glyph and no style, and neither does a food -
    // stays 0 or empty here, which is what a real file reports. Nothing is made up: the row
    // prints only what the file had.
    enchantName: spec.enchant || '',
    styleName: spec.style || '',
    requiredLevel: spec.level || 0,
    requiredCp: spec.cp || 0,
    flavorText: null,
    esoData: null,
    furnitureDataId: 0,
    locationKey: `demo:${index}`,
    locationLabel: spec.location,
    itemCount: spec.count || 1,
    firstDumpedAt: seconds,
    lastDumpedAt: seconds,
    guildIds,
  };
}

export function buildOffer(spec, index, guildIds, { accountName = DEMO_ACCOUNT, characterName = DEMO_CHARACTER } = {}) {
  const link = itemLinkFor(spec.itemId);
  const seconds = Math.trunc(Date.now() / 1000) - index * 7200;

  return {
    accountName,
    characterName,
    itemKey: `${link}||demo-offer:${index}`,
    itemLink: link,
    itemId: spec.itemId,
    icon: '',
    itemName: spec.name,
    itemType: spec.type,
    itemTypeName: spec.typeName,
    quality: spec.quality,
    qualityName: spec.qualityName,
    trait: spec.trait || '',
    traitType: '',
    apparelSlot: spec.slot || '',
    equipType: '',
    apparelWeight: '',
    armorType: '',
    weaponType: spec.weapon || '',
    weaponHandedness: '',
    setName: spec.set || '',
    // The fields the list reads: ESO gates gear by level or by champion points, and the
    // enchanting and the style are half of why somebody wants the piece. A spec that leaves
    // one out - a material has no level, no glyph and no style, and neither does a food -
    // stays 0 or empty here, which is what a real file reports. Nothing is made up: the row
    // prints only what the file had.
    enchantName: spec.enchant || '',
    styleName: spec.style || '',
    requiredLevel: spec.level || 0,
    requiredCp: spec.cp || 0,
    flavorText: null,
    esoData: null,
    furnitureDataId: 0,
    firstAddedAt: seconds,
    lastUpdatedAt: seconds,
    guildIds,
  };
}
