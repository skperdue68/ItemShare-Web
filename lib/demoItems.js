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
    level: 1,
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
    level: 1,
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
    level: 1,
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
    level: 1,
    location: 'Furnishing Vault (Hall of the Lunar Champion)',
    count: 1,
  },
];

export const OFFERS = [
  {
    itemId: 76431,
    held: 3,
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
  },
  {
    itemId: 64705,
    held: 24,
    name: 'Aetherial Ambrosia',
    type: 6,
    typeName: 'Consumable',
    quality: 4,
    qualityName: 'Legendary',
    level: 1,
  },
  {
    itemId: 60213,
    held: 12,
    name: 'Perfect Roe',
    type: 5,
    typeName: 'Material',
    quality: 4,
    qualityName: 'Legendary',
    level: 1,
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
    // enchantment is half of why somebody wants the piece. A catalogue without them showed
    // every demo row as a level 0 item with no enchantment. A thing that is not gear still
    // has a level - 1, the level an item with no requirement carries - because a row with
    // no level at all reads as one whose level is unknown; what it has not got is champion
    // points, a glyph or a style, and none of those is invented for it.
    enchantName: spec.enchant || '',
    styleName: '',
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
    // enchantment is half of why somebody wants the piece. A catalogue without them showed
    // every demo row as a level 0 item with no enchantment. A thing that is not gear still
    // has a level - 1, the level an item with no requirement carries - because a row with
    // no level at all reads as one whose level is unknown; what it has not got is champion
    // points, a glyph or a style, and none of those is invented for it.
    enchantName: spec.enchant || '',
    styleName: '',
    requiredLevel: spec.level || 0,
    requiredCp: spec.cp || 0,
    flavorText: null,
    esoData: null,
    furnitureDataId: 0,
    firstAddedAt: seconds,
    lastUpdatedAt: seconds,
    // How many the demo owner holds, so a standing offer shows the same arithmetic a real
    // file's does: offered is what is held less what is kept back. A file that reports
    // neither count still means one copy, which is what the list falls back to.
    heldQuantity: Math.max(0, Number(spec.held) || 0),
    reserveQuantity: Math.max(0, Number(spec.keep) || 0),
    guildIds,
  };
}
