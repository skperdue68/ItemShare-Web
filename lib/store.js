// Database operations behind the website (server.js) and its operator scripts.
//
// An upload fills in what the file has and then prunes what it does not: every row
// the file mentions is written in place, and only afterwards are the rows it no
// longer mentions removed. The whole thing runs inside one transaction, so nobody
// ever reads a half-replaced list.
//
// That order matters for more than politeness. Replacing the list with a DELETE
// and a fresh set of INSERTs gave every row a new id, which silently orphaned
// anything pointing at it - including an open request - and made an item vanish
// for as long as the inserts took.

import { createHash, randomBytes } from 'node:crypto';

import { iconCacheKey } from './icons.js';
import { sanitizeAvatarUrl } from './identity.js';
import { newGuildCode, normalizeGuildCode } from './guildCodes.js';

const ITEM_COLUMNS = [
  'account_name',
  'character_name',
  'item_key',
  'item_key_hash',
  'item_link',
  'item_name',
  'item_id',
  'icon',
  'icon_key',
  'item_type',
  'item_type_name',
  'quality',
  'quality_name',
  'trait',
  'trait_type',
  'apparel_slot',
  'equip_type',
  'apparel_weight',
  'armor_type',
  'weapon_type',
  'weapon_handedness',
  'set_name',
  'enchant_name',
  'style_name',
  'required_level',
  'required_cp',
  'flavor_text',
  'eso_data',
  'furniture_data_id',
  'location_key',
  'location_label',
  'item_count',
  'held_quantity',
  'reserve_quantity',
  'first_dumped_at',
  'last_dumped_at',
  'upload_id',
];

const INSERT_ITEM_SQL = `
INSERT INTO itemshare_shared_items (${ITEM_COLUMNS.join(', ')})
VALUES (${ITEM_COLUMNS.map(() => '?').join(', ')})`;

// The same row, refreshed where it stands. LAST_INSERT_ID(id) hands back the id of
// the row that already existed, which is what the guild links and any open request
// are attached to; first_seen_at is deliberately absent so the first sighting of an
// item survives every later upload.
const ITEM_UPSERT_SQL = `${INSERT_ITEM_SQL}
ON DUPLICATE KEY UPDATE ${['id = LAST_INSERT_ID(id)', ...ITEM_COLUMNS.map((column) => `${column} = VALUES(${column})`)].join(', ')}`;

export function hashItemKey(itemKey) {
  return createHash('sha1').update(itemKey, 'utf8').digest('hex');
}

function itemValues(item, uploadId) {
  const values = [
    item.accountName,
    item.characterName,
    item.itemKey,
    hashItemKey(item.itemKey),
    item.itemLink,
    item.itemName,
    item.itemId || 0,
    item.icon || '',
    iconCacheKey(item.icon),
    item.itemType,
    item.itemTypeName,
    item.quality,
    item.qualityName,
    item.trait,
    item.traitType,
    item.apparelSlot,
    item.equipType,
    item.apparelWeight,
    item.armorType,
    item.weaponType,
    item.weaponHandedness,
    item.setName || '',
    item.enchantName || '',
    item.styleName || '',
    item.requiredLevel || 0,
    item.requiredCp || 0,
    item.flavorText || null,
    item.esoData || null,
    item.furnitureDataId,
    item.locationKey,
    item.locationLabel,
    item.itemCount,
    item.heldQuantity || 0,
    item.reserveQuantity || 0,
    item.firstDumpedAt,
    item.lastDumpedAt,
    uploadId,
  ];

  // The INSERT is built from ITEM_COLUMNS, so a value added without a column (or
  // the reverse) would shift every field silently. Fail loudly instead.
  if (values.length !== ITEM_COLUMNS.length) {
    throw new Error(
      `Item column mismatch: ${values.length} values for ${ITEM_COLUMNS.length} columns`
    );
  }

  return values;
}

const ALWAYS_COLUMNS = [
  'account_name',
  'character_name',
  'item_key',
  'item_key_hash',
  'item_link',
  'item_name',
  'item_id',
  'icon',
  'icon_key',
  'item_type',
  'item_type_name',
  'quality',
  'quality_name',
  'trait',
  'trait_type',
  'apparel_slot',
  'equip_type',
  'apparel_weight',
  'armor_type',
  'weapon_type',
  'weapon_handedness',
  'set_name',
  'enchant_name',
  'style_name',
  'required_level',
  'required_cp',
  'flavor_text',
  'eso_data',
  'furniture_data_id',
  'held_quantity',
  'reserve_quantity',
  'first_added_at',
  'last_updated_at',
  'upload_id',
];

const INSERT_ALWAYS_SHARE_SQL = `
INSERT INTO itemshare_always_share (${ALWAYS_COLUMNS.join(', ')})
VALUES (${ALWAYS_COLUMNS.map(() => '?').join(', ')})`;

const ALWAYS_SHARE_UPSERT_SQL = `${INSERT_ALWAYS_SHARE_SQL}
ON DUPLICATE KEY UPDATE ${['id = LAST_INSERT_ID(id)', ...ALWAYS_COLUMNS.map((column) => `${column} = VALUES(${column})`)].join(', ')}`;

function alwaysShareValues(entry, uploadId) {
  const values = [
    entry.accountName,
    entry.characterName || '',
    entry.itemKey,
    hashItemKey(entry.itemKey),
    entry.itemLink || '',
    entry.itemName || '',
    entry.itemId || 0,
    entry.icon || '',
    iconCacheKey(entry.icon),
    entry.itemType || 0,
    entry.itemTypeName || '',
    entry.quality || 0,
    entry.qualityName || '',
    entry.trait || '',
    entry.traitType || '',
    entry.apparelSlot || '',
    entry.equipType || '',
    entry.apparelWeight || '',
    entry.armorType || '',
    entry.weaponType || '',
    entry.weaponHandedness || '',
    entry.setName || '',
    entry.enchantName || '',
    entry.styleName || '',
    entry.requiredLevel || 0,
    entry.requiredCp || 0,
    entry.flavorText || null,
    entry.esoData || null,
    entry.furnitureDataId || 0,
    entry.heldQuantity || 0,
    entry.reserveQuantity || 0,
    entry.firstAddedAt || 0,
    entry.lastUpdatedAt || 0,
    uploadId,
  ];

  if (values.length !== ALWAYS_COLUMNS.length) {
    throw new Error(
      `Always share column mismatch: ${values.length} values for ${ALWAYS_COLUMNS.length} columns`
    );
  }

  return values;
}

// A guild is the same guild only within one megaserver, so the world a file was written
// on is part of every guild row it touches. 0 / '' mean "not known" and are stored as
// given rather than guessed.
function worldOf(world = {}) {
  return {
    platform: Number(world.platform) || 0,
    worldName: String(world.worldName || '').slice(0, 64),
  };
}

async function upsertGuilds(connection, guilds, world = {}) {
  const { platform, worldName } = worldOf(world);

  for (const [guildId, guildName] of guilds) {
    await connection.execute(
      `INSERT INTO itemshare_guilds (guild_id, guild_name, platform, world_name) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE guild_name = IF(VALUES(guild_name) = '', guild_name, VALUES(guild_name))`,
      [guildId, guildName, platform, worldName]
    );
  }
}

async function replaceAccountGuilds(connection, accountName, guilds, world = {}) {
  const { platform, worldName } = worldOf(world);

  // What the game reported, and only that. A membership granted by a guild code is not in
  // the file, so an upload must not read its absence as "no longer a member": deleting
  // `granted_code_id` rows here would take an invitation away on the next file.
  await connection.execute(
    'DELETE FROM itemshare_account_guilds WHERE account_name = ? AND granted_code_id IS NULL',
    [accountName]
  );

  for (const guildId of guilds.keys()) {
    await connection.execute(
      'INSERT IGNORE INTO itemshare_account_guilds (account_name, guild_id, platform, world_name) VALUES (?, ?, ?, ?)',
      [accountName, guildId, platform, worldName]
    );
  }

  // A membership that came from a code stops being an extra the moment the file itself
  // reports that guild on that server: from then on the game is where it comes from, and
  // the next upload replaces it like any other. Until then the mark stays, which is what
  // lets an invited member stay in the guild without their file ever mentioning it.
  if (guilds.size > 0) {
    const reported = [...guilds.keys()];

    await connection.execute(
      `UPDATE itemshare_account_guilds
          SET granted_code_id = NULL
        WHERE account_name = ? AND granted_code_id IS NOT NULL
          AND platform = ? AND world_name = ?
          AND guild_id IN (${inClause(reported)})`,
      [accountName, platform, worldName, ...reported]
    );
  }
}

/**
 * Replaces the shared items and guild membership of one ESO account. Runs inside
 * the caller's transaction so every account in a file is replaced atomically.
 */
/**
 * Fills in an icon path for items that arrived without one, using the path a
 * previous upload already recorded for the same item id.
 *
 * The addon cannot always answer with an icon (some bags, some client versions),
 * and an upload used to overwrite the row with an empty path, which then erased
 * the only copy of it. Reusing the known path costs one query per upload and
 * means an item seen once with an icon keeps its image.
 *
 * @returns {Promise<number>} how many entries were given a path
 */
/**
 * Item ids that still have no icon path on any row, for the repair pass. Ids that
 * already have a path somewhere are excluded: those rows are filled from that
 * path by the next upload, and a known id never needs UESP again.
 *
 * @returns {Promise<number[]>}
 */
export async function getItemIdsMissingIcons(connection, limit = 20) {
  // The batch is inlined rather than bound: LIMIT placeholders are not portable
  // across the MySQL and MariaDB drivers this site runs against.
  const batch = Math.min(Math.max(Math.trunc(Number(limit)) || 20, 1), 200);

  const [rows] = await connection.execute(
    `SELECT item_id FROM (
       SELECT item_id FROM itemshare_shared_items WHERE item_id > 0 AND (icon IS NULL OR icon = '')
       UNION
       SELECT item_id FROM itemshare_always_share WHERE item_id > 0 AND (icon IS NULL OR icon = '')
     ) AS missing
     WHERE item_id NOT IN (
       SELECT item_id FROM itemshare_shared_items WHERE item_id > 0 AND icon IS NOT NULL AND icon <> ''
       UNION
       SELECT item_id FROM itemshare_always_share WHERE item_id > 0 AND icon IS NOT NULL AND icon <> ''
     )
     ORDER BY item_id
     LIMIT ${batch}`
  );

  return rows
    .map((row) => Number(row.item_id))
    .filter((itemId) => Number.isFinite(itemId) && itemId > 0);
}

/**
 * Rows whose recorded icon path never produced an image: the path is there, but the
 * mirror has nothing at it, so the page has always shown a blank tile. Set items are
 * the usual case - the client's path is real in-game but is not mirrored under that
 * name - and the repair is the one blank rows already get: ask UESP for the canonical
 * path and replace what is stored.
 *
 * @returns {Promise<{itemId: number, icon: string}[]>}
 */
export async function getUncachedIconItems(connection, limit = 20) {
  const batch = Math.min(Math.max(Math.trunc(Number(limit)) || 20, 1), 200);

  const [rows] = await connection.execute(
    `SELECT item_id, icon FROM (
       SELECT i.item_id, i.icon
         FROM itemshare_shared_items i
         LEFT JOIN itemshare_item_icons cached ON cached.icon_key = i.icon_key
        WHERE i.item_id > 0 AND i.icon <> '' AND cached.icon_key IS NULL
       UNION
       SELECT a.item_id, a.icon
         FROM itemshare_always_share a
         LEFT JOIN itemshare_item_icons cached ON cached.icon_key = a.icon_key
        WHERE a.item_id > 0 AND a.icon <> '' AND cached.icon_key IS NULL
     ) AS uncached
     ORDER BY item_id
     LIMIT ${batch}`
  );

  return rows
    .map((row) => ({ itemId: Number(row.item_id), icon: String(row.icon || '') }))
    .filter((row) => Number.isFinite(row.itemId) && row.itemId > 0);
}

/**
 * Writes recovered icon paths onto every row that is still blank for those item
 * ids, in both tables. Guards the rows that already have a path, so a concurrent
 * upload is never overwritten with an older answer.
 *
 * With `replaceUncached` a path that never produced an image is replaced as well -
 * a recorded path with no cached PNG is as broken as a blank one, and it is what
 * kept some items (set items especially) a placeholder for ever.
 *
 * @returns {Promise<number>} rows touched
 */
export async function fillIconsByItemId(connection, iconByItemId, { replaceUncached = false } = {}) {
  let rows = 0;

  for (const [itemId, icon] of iconByItemId || []) {
    const path = String(icon || '');

    if (!path) {
      continue;
    }

    const iconKey = iconCacheKey(path);

    for (const table of ['itemshare_shared_items', 'itemshare_always_share']) {
      const [result] = await connection.execute(
        `UPDATE ${table} SET icon = ?, icon_key = ?
          WHERE item_id = ? AND (icon IS NULL OR icon = '')`,
        [path, iconKey, itemId]
      );
      rows += result.affectedRows || 0;

      if (!replaceUncached) {
        continue;
      }

      const [replaced] = await connection.execute(
        `UPDATE ${table} SET icon = ?, icon_key = ?
          WHERE item_id = ?
            AND icon IS NOT NULL AND icon <> '' AND icon <> ?
            AND icon_key NOT IN (SELECT icon_key FROM itemshare_item_icons)`,
        [path, iconKey, itemId, path]
      );
      rows += replaced.affectedRows || 0;
    }
  }

  return rows;
}

export async function fillKnownIcons(connection, entries) {
  const missing = new Map();

  for (const entry of entries) {
    if (entry.icon || !entry.itemId) {
      continue;
    }
    if (!missing.has(entry.itemId)) {
      missing.set(entry.itemId, []);
    }
    missing.get(entry.itemId).push(entry);
  }

  if (missing.size === 0) {
    return 0;
  }

  const ids = [...missing.keys()];
  const known = new Map();

  for (let start = 0; start < ids.length; start += 250) {
    const chunk = ids.slice(start, start + 250);
    const placeholders = chunk.map(() => '?').join(', ');
    const [rows] = await connection.execute(
      `SELECT item_id, icon FROM itemshare_shared_items
        WHERE item_id IN (${placeholders}) AND icon <> ''
        UNION
       SELECT item_id, icon FROM itemshare_always_share
        WHERE item_id IN (${placeholders}) AND icon <> ''`,
      [...chunk, ...chunk]
    );

    for (const row of rows) {
      const itemId = Number(row.item_id);
      if (!known.has(itemId)) {
        known.set(itemId, row.icon);
      }
    }
  }

  let filled = 0;

  for (const [itemId, waiting] of missing) {
    const icon = known.get(itemId);
    if (!icon) {
      continue;
    }
    for (const entry of waiting) {
      entry.icon = icon;
      filled += 1;
    }
  }

  return filled;
}

/**
 * Finds the rows an upload must not touch because somebody is still waiting on them.
 *
 * The file was written before the owner answered those requests, so its count no longer
 * describes the bag the promised copies are going to leave: taking it would re-offer what
 * has already been claimed, and could cancel a request that is perfectly answerable. The
 * rows named here keep the numbers they had. They are stamped with this upload's id
 * without anything else changing, so the prune at the end leaves them standing.
 *
 * @returns {Promise<{hashes: Set<string>, items: Array<{itemName: string, requests: number}>}>}
 */
async function holdRequestsOpenItems(connection, accountName, items, uploadId) {
  const hashes = new Set();
  const held = [];

  if (!Array.isArray(items) || items.length === 0) {
    return { hashes, items: held };
  }

  const [rows] = await connection.execute(
    `SELECT i.id, i.item_key_hash, i.item_name, COUNT(r.id) AS requests
       FROM itemshare_shared_items i
       JOIN itemshare_requests r
         ON r.shared_item_id = i.id AND r.item_kind = 'inventory' AND ${holdingSql('r')}
      WHERE i.account_name = ?
      GROUP BY i.id, i.item_key_hash, i.item_name`,
    [accountName]
  );

  if (rows.length === 0) {
    return { hashes, items: held };
  }

  const incoming = new Map(items.map((item) => [hashItemKey(item.itemKey), item]));

  for (const row of rows) {
    const hash = String(row.item_key_hash || '');

    if (!incoming.has(hash)) {
      continue;
    }

    hashes.add(hash);
    held.push({
      itemName: String(row.item_name || incoming.get(hash).itemName || 'an item'),
      requests: Number(row.requests) || 0,
    });

    await connection.execute('UPDATE itemshare_shared_items SET upload_id = ? WHERE id = ?', [
      uploadId,
      Number(row.id),
    ]);
  }

  return { hashes, items: held };
}

async function replaceOneAccount(
  connection,
  {
    accountName,
    items,
    alwaysShare = [],
    guilds,
    sourceFile,
    addonVersion = '',
    userId,
    platform = 0,
    worldName = '',
  }
) {
  const totalQuantity = items.reduce((sum, item) => sum + (item.itemCount || 0), 0);
  const world = worldOf({ platform, worldName });

  await upsertGuilds(connection, guilds, world);
  await replaceAccountGuilds(connection, accountName, guilds, world);

  // The account itself is written here, not only when somebody links it: this row is
  // where its platform and megaserver live, and it is what a name attached by hand is
  // filled in from the first time a file arrives. An existing owner is left attached -
  // user_id only takes part in the insert.
  await connection.execute(
    `INSERT INTO itemshare_accounts (eso_account_name, user_id, platform, world_name)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE platform = VALUES(platform), world_name = VALUES(world_name)`,
    [accountName, userId || null, world.platform, world.worldName]
  );

  const [upload] = await connection.execute(
    `INSERT INTO itemshare_uploads
       (account_name, character_name, source_file, addon_version, item_count, total_quantity, guild_count, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      accountName,
      '*',
      sourceFile || '',
      addonVersion || '',
      items.length,
      totalQuantity,
      guilds.size,
      userId || null,
    ]
  );

  const uploadId = upload.insertId;

  // Anything with an open request keeps the count it had; see holdRequestsOpenItems.
  const heldBack = await holdRequestsOpenItems(connection, accountName, items, uploadId);

  // Write first, prune second. Everything the file mentions is refreshed where it
  // already stands - same row, same id, same first_seen_at - so an item never
  // blinks out of the list and anything pointing at the row keeps pointing at it.
  for (const item of items) {
    if (heldBack.hashes.has(hashItemKey(item.itemKey))) {
      continue;
    }

    const [written] = await connection.execute(ITEM_UPSERT_SQL, itemValues(item, uploadId));
    const itemId = written.insertId;

    // The guilds an item is offered to can change between uploads, so the links
    // are rewritten per item rather than left to accumulate.
    await connection.execute('DELETE FROM itemshare_shared_item_guilds WHERE item_id = ?', [itemId]);

    for (const guildId of item.guildIds) {
      await connection.execute(
        'INSERT IGNORE INTO itemshare_shared_item_guilds (item_id, guild_id, platform, world_name) VALUES (?, ?, ?, ?)',
        [itemId, guildId, world.platform, world.worldName]
      );
    }
  }

  // Everything above now carries this upload's id, so a row still holding an older
  // one was in a previous file and is gone from this one. That is the whole prune:
  // upload_id doubles as the refresh mark, and no extra column is needed to say
  // when a row was last confirmed.
  const [removedItems] = await connection.execute(
    'DELETE FROM itemshare_shared_items WHERE account_name = ? AND (upload_id IS NULL OR upload_id <> ?)',
    [accountName, uploadId]
  );

  // Standing offers get the same treatment, but stay in their own table: an offer
  // has no count and no location, and must survive the item leaving every bag.
  for (const offered of alwaysShare) {
    const [written] = await connection.execute(
      ALWAYS_SHARE_UPSERT_SQL,
      alwaysShareValues(offered, uploadId)
    );
    const offerId = written.insertId;

    await connection.execute('DELETE FROM itemshare_always_share_guilds WHERE always_share_id = ?', [offerId]);

    for (const guildId of offered.guildIds) {
      await connection.execute(
        'INSERT IGNORE INTO itemshare_always_share_guilds (always_share_id, guild_id, platform, world_name) VALUES (?, ?, ?, ?)',
        [offerId, guildId, world.platform, world.worldName]
      );
    }
  }

  const [removedOffers] = await connection.execute(
    'DELETE FROM itemshare_always_share WHERE account_name = ? AND (upload_id IS NULL OR upload_id <> ?)',
    [accountName, uploadId]
  );

  // An upload is exactly what changes the numbers a request was made against, so
  // the reservations are settled here, inside the same transaction: a request can
  // never be left standing against a stack that no longer covers it.
  const cancelledRequests = await reconcileRequestsForOwner(connection, accountName);

  return {
    accountName,
    uploadId,
    platform: world.platform,
    worldName: world.worldName,
    itemCount: items.length,
    totalQuantity,
    guildCount: guilds.size,
    alwaysShareCount: alwaysShare.length,
    removedItems: Number(removedItems.affectedRows || 0),
    removedOffers: Number(removedOffers.affectedRows || 0),
    cancelledRequests,
    heldBack: heldBack.items,
  };
}

/**
 * Full replace for every ESO account in one saved variables file. Either all of
 * the accounts are updated or, on any failure, none of them are.
 * @param {Array<{accountName: string, items: object[], guilds: Map<number, string>}>} accounts
 * @returns {Promise<Array<{accountName: string, uploadId: number, itemCount: number, totalQuantity: number, guildCount: number}>>}
 */
export async function replaceAccounts(
  connection,
  accounts,
  { sourceFile, userId, addonVersion = '' } = {}
) {
  await connection.beginTransaction();

  try {
    // Before anything is deleted: recover icon paths from the rows this upload is
    // about to replace, so a missing getter does not cost the image.
    await fillKnownIcons(connection, [
      ...accounts.flatMap((account) => account.items || []),
      ...accounts.flatMap((account) => account.alwaysShare || []),
    ]);

    const results = [];
    for (const account of accounts) {
      // A file can name a different addon version per account; the option is the
      // fallback for callers that pass one value for the whole upload.
      results.push(
        await replaceOneAccount(connection, {
          ...account,
          sourceFile,
          userId,
          addonVersion: account.addonVersion || addonVersion,
        })
      );
    }
    await connection.commit();
    return results;
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

/**
 * Resolves the person behind a provider sign-in.
 *
 * 1. a known (provider, provider_user_id) identity wins;
 * 2. otherwise a verified email that already belongs to a person joins that
 *    person, so Discord and Google logins of the same human share their ESO
 *    accounts instead of creating a second, empty account;
 * 3. otherwise a new person is created.
 *
 * @returns {Promise<{userId: number, displayName: string, email: string, emailVerified: boolean, matched: 'identity'|'email'|'created'}>}
 */
export async function signInWithProvider(
  connection,
  { provider, providerUserId, username, email, emailVerified, avatarUrl = '' }
) {
  const providerKey = String(provider);
  const subject = String(providerUserId);
  const address = email || '';
  const verified = Boolean(emailVerified);
  const name = username || '';
  const picture = sanitizeAvatarUrl(avatarUrl);

  const [identityRows] = await connection.execute(
    'SELECT user_id FROM itemshare_user_identities WHERE provider = ? AND provider_user_id = ?',
    [providerKey, subject]
  );

  let userId = identityRows[0] ? Number(identityRows[0].user_id) : null;
  let matched = 'identity';

  if (userId === null && address && verified) {
    const [byEmail] = await connection.execute(
      `SELECT id FROM itemshare_users
        WHERE email = ? AND email_verified = 1
        ORDER BY id ASC
        LIMIT 1`,
      [address]
    );

    if (byEmail[0]) {
      userId = Number(byEmail[0].id);
      matched = 'email';
    }
  }

  if (userId === null) {
    const [inserted] = await connection.execute(
      'INSERT INTO itemshare_users (display_name, email, email_verified, avatar_url) VALUES (?, ?, ?, ?)',
      [name, address, verified ? 1 : 0, picture]
    );
    userId = Number(inserted.insertId);
    matched = 'created';
  } else {
    await connection.execute(
      `UPDATE itemshare_users
          SET display_name = IF(? = '', display_name, ?),
              email = IF(? = '', email, ?),
              email_verified = IF(? = 1, 1, email_verified),
              avatar_url = IF(? = '', avatar_url, ?)
        WHERE id = ?`,
      [name, name, address, address, verified ? 1 : 0, picture, picture, userId]
    );
  }

  await connection.execute(
    `INSERT INTO itemshare_user_identities
       (provider, provider_user_id, user_id, provider_username, provider_email, email_verified)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       user_id = VALUES(user_id),
       provider_username = VALUES(provider_username),
       provider_email = VALUES(provider_email),
       email_verified = VALUES(email_verified)`,
    [providerKey, subject, userId, name, address, verified ? 1 : 0]
  );

  return { userId, displayName: name, email: address, emailVerified: verified, avatarUrl: picture, matched };
}

/** Email for an ESO account's owner, for request notifications. */
export async function getOwnerNotificationEmail(connection, accountName) {
  const [rows] = await connection.execute(
    `SELECT u.email, u.email_verified
       FROM itemshare_accounts a
       JOIN itemshare_users u ON u.id = a.user_id
      WHERE a.eso_account_name = ?`,
    [accountName]
  );

  const row = rows[0];
  if (!row || !row.email) {
    return null;
  }
  return { email: row.email, verified: Number(row.email_verified) === 1 };
}

/**
 * The address to notify for each owner account in one query. Several ESO accounts can
 * belong to one person, so the caller groups by address rather than by account.
 * Accounts nobody has linked are simply absent.
 *
 * @returns {Promise<Map<string, {email: string, verified: boolean}>>}
 */
export async function getOwnerContacts(connection, accountNames) {
  const names = [...new Set((accountNames || []).map(String).filter(Boolean))];

  if (names.length === 0) {
    return new Map();
  }

  const [rows] = await connection.execute(
    `SELECT a.eso_account_name, u.email, u.email_verified
       FROM itemshare_accounts a
       JOIN itemshare_users u ON u.id = a.user_id
      WHERE a.eso_account_name IN (${inClause(names)})`,
    names
  );

  return new Map(
    rows
      .filter((row) => row.email)
      .map((row) => [
        String(row.eso_account_name),
        { email: String(row.email), verified: Number(row.email_verified) === 1 },
      ])
  );
}

/**
 * The people who asked, addressed for the answer email.
 *
 * Read after the answer is recorded, not before: the row is closed by then, and what
 * the message has to say is what actually happened to it. A requester whose sign-in
 * has no email address is simply absent, so nobody is invented and nobody is mailed a
 * row they cannot read.
 *
 * @returns {Promise<Array<object>>} one entry per answered request, with its address
 */
export async function getRequesterNotifications(connection, requestIds) {
  const ids = (requestIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0);

  if (ids.length === 0) {
    return [];
  }

  const [rows] = await connection.execute(
    `SELECT r.id, r.status, r.status_reason, r.item_name, r.quality, r.item_type_name,
            r.trait, r.enchant_name, r.owner_account_name, r.requester_account_name,
            r.quantity, r.quantity_requested, u.email, u.display_name
       FROM itemshare_requests r
       JOIN itemshare_users u ON u.id = r.requester_user_id
      WHERE r.id IN (${inClause(ids)}) AND u.email <> ''
      ORDER BY r.id ASC`,
    ids
  );

  return rows.map((row) => ({
    id: Number(row.id),
    status: String(row.status || ''),
    statusReason: row.status_reason || '',
    itemName: row.item_name || 'Item',
    quality: Number(row.quality) || 0,
    type: row.item_type_name || '',
    trait: row.trait || '',
    enchant: row.enchant_name || '',
    ownerAccount: row.owner_account_name || '',
    requesterAccount: row.requester_account_name || '',
    sent: Number(row.quantity) || 0,
    asked: Math.max(1, Number(row.quantity_requested) || Number(row.quantity) || 1),
    email: String(row.email || ''),
    displayName: row.display_name || '',
  }));
}

/**
 * The requests that really went out, for the owner email.
 *
 * Read after the update on purpose: a draft can lapse between being read and being
 * sent, and an item nobody actually asked for must not appear in an inbox.
 *
 * @returns {Promise<Array<{id: number, owner_account_name: string, item_name: string, quantity: number, requester_account_name: string}>>}
 */
export async function getSubmittedRequests(connection, userId, ids) {
  const wanted = (ids || []).map(Number).filter((id) => Number.isFinite(id) && id > 0);

  if (wanted.length === 0) {
    return [];
  }

  const [rows] = await connection.execute(
    `SELECT id, owner_account_name, item_name, quantity, quantity_requested,
            requester_account_name, item_type_name, trait, enchant_name, quality,
            location_label
       FROM itemshare_requests
      WHERE requester_user_id = ? AND status = 'pending' AND submitted_at IS NOT NULL
        AND id IN (${inClause(wanted)})
      ORDER BY id ASC`,
    [Number(userId), ...wanted]
  );

  return rows;
}

export async function getAccountSummary(connection, accountName) {
  const [[items]] = await connection.execute(
    `SELECT COUNT(*) AS itemCount, COALESCE(SUM(item_count), 0) AS totalQuantity
       FROM itemshare_shared_items WHERE account_name = ?`,
    [accountName]
  );

  const [[guilds]] = await connection.execute(
    `SELECT COUNT(*) AS guildCount FROM itemshare_account_guilds WHERE account_name = ?`,
    [accountName]
  );

  const [[lastUpload]] = await connection.execute(
    `SELECT uploaded_at, item_count, total_quantity, source_file, addon_version
       FROM itemshare_uploads WHERE account_name = ?
      ORDER BY id DESC LIMIT 1`,
    [accountName]
  );

  const [linked] = await connection.execute(
    `SELECT a.user_id, u.display_name
       FROM itemshare_accounts a
       LEFT JOIN itemshare_users u ON u.id = a.user_id
      WHERE a.eso_account_name = ?`,
    [accountName]
  );

  // The server the addon last reported for this account, or 0 / '' when no file has ever
  // said - a name attached by hand, until it uploads once.
  const [server] = await connection.execute(
    `SELECT platform, world_name FROM itemshare_accounts
      WHERE eso_account_name = ?
      LIMIT 1`,
    [accountName]
  );

  return {
    itemCount: Number(items?.itemCount || 0),
    totalQuantity: Number(items?.totalQuantity || 0),
    guildCount: Number(guilds?.guildCount || 0),
    lastUpload: lastUpload || null,
    link: linked[0] || null,
    platform: Number(server[0]?.platform || 0),
    worldName: String(server[0]?.world_name || ''),
  };
}

/** Every ESO account linked to one person, oldest link first. */
export async function getViewerAccounts(connection, userId) {
  const [rows] = await connection.execute(
    `SELECT a.eso_account_name, a.user_id, a.linked_at, u.display_name
       FROM itemshare_accounts a
       LEFT JOIN itemshare_users u ON u.id = a.user_id
      WHERE a.user_id = ?
      ORDER BY a.linked_at ASC, a.eso_account_name ASC`,
    [Number(userId)]
  );
  return rows;
}

/**
 * The ESO account this person chose to browse as, or '' when they never chose.
 * A name that is no longer linked is the caller's problem to resolve, not silently
 * dropped here: the row is read as stored so "chosen" and "gone" stay distinguishable.
 */
export async function getBrowsingAccount(connection, userId) {
  const [rows] = await connection.execute(
    `SELECT browsing_eso_account_name FROM itemshare_users WHERE id = ?`,
    [Number(userId)]
  );

  return rows[0] ? String(rows[0].browsing_eso_account_name || '') : '';
}

/**
 * Remembers the account someone browses as. The caller must have proven the account is
 * linked to this person first: this only writes, it does not check ownership.
 */
export async function setBrowsingAccount(connection, userId, accountName) {
  await connection.execute(
    `UPDATE itemshare_users SET browsing_eso_account_name = ? WHERE id = ?`,
    [String(accountName || ''), Number(userId)]
  );
}

// ---------------------------------------------------------- email and password
/**
 * The person behind an email address and password, or null when nobody signed up with
 * that address.
 *
 * Only rows written by the email form are read here. An address that arrived from
 * Discord or Google has no password, and joining those two worlds by an unverified
 * address typed into a box is exactly how somebody takes over another person's
 * account, so an address only ever signs in the way it was first used.
 *
 * @returns {Promise<{userId: number, displayName: string, email: string, passwordHash: string}|null>}
 */
export async function findPasswordLogin(connection, email) {
  const [rows] = await connection.execute(
    `SELECT u.id, u.display_name, u.email, u.is_demo, p.password_hash
       FROM itemshare_user_identities i
       JOIN itemshare_users u ON u.id = i.user_id
       JOIN itemshare_passwords p ON p.user_id = u.id
      WHERE i.provider = 'password' AND i.provider_user_id = ?
      LIMIT 1`,
    [String(email || '')]
  );

  const row = rows[0];

  if (!row) {
    return null;
  }

  return {
    userId: Number(row.id),
    displayName: String(row.display_name || ''),
    email: String(row.email || ''),
    passwordHash: String(row.password_hash || ''),
    // The demo is an ordinary password sign-in that must not be allowed to write.
    isDemo: Number(row.is_demo) === 1,
  };
}

/** Records that a password was used. Nothing depends on it; it is for the operator. */
export async function notePasswordUsed(connection, userId) {
  await connection.execute(
    'UPDATE itemshare_passwords SET last_used_at = NOW() WHERE user_id = ?',
    [Number(userId)]
  );
}

/**
 * Makes a person with an email address and a password.
 *
 * The address is the identity, so it cannot be used twice, and it is stored unverified:
 * nobody proved they can read mail at that address, so it must not join an existing
 * person the way a verified provider address does.
 *
 * @returns {Promise<{created: boolean, userId: number}>} created is false when the
 *   address already has an account, and the existing person is not signed in
 */
export async function createPasswordAccount(connection, { email, passwordHash, displayName }) {
  const address = String(email || '');
  const name = String(displayName || '').slice(0, 96);

  const [existing] = await connection.execute(
    `SELECT user_id FROM itemshare_user_identities
      WHERE provider = 'password' AND provider_user_id = ?`,
    [address]
  );

  if (existing[0]) {
    return { created: false, userId: Number(existing[0].user_id) };
  }

  const [inserted] = await connection.execute(
    'INSERT INTO itemshare_users (display_name, email, email_verified) VALUES (?, ?, 0)',
    [name, address]
  );
  const userId = Number(inserted.insertId);

  await connection.execute(
    `INSERT INTO itemshare_user_identities
       (provider, provider_user_id, user_id, provider_username, provider_email, email_verified)
     VALUES ('password', ?, ?, ?, ?, 0)
     ON DUPLICATE KEY UPDATE
       user_id = VALUES(user_id),
       provider_username = VALUES(provider_username)`,
    [address, userId, name, address]
  );

  await connection.execute(
    `INSERT INTO itemshare_passwords (user_id, password_hash) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
    [userId, passwordHash]
  );

  return { created: true, userId };
}

/** How long a reset link lives. Short on purpose: while it is alive it is the account. */
export const RESET_TOKEN_MINUTES = 30;

/**
 * One live reset link for an address, or null when that address has no password account.
 *
 * The old links for that person go first: asking twice must not leave two working keys in
 * two inboxes. The token itself is returned and never stored - the row keeps its SHA-256,
 * so the message is the only copy of it.
 *
 * @returns {Promise<{token: string, userId: number, email: string, displayName: string}|null>}
 */
export async function createPasswordReset(connection, email) {
  const [rows] = await connection.execute(
    `SELECT u.id AS user_id, u.display_name, u.email
       FROM itemshare_user_identities i
       JOIN itemshare_users u ON u.id = i.user_id
       JOIN itemshare_passwords p ON p.user_id = u.id
      WHERE i.provider = 'password' AND i.provider_user_id = ?
      LIMIT 1`,
    [String(email || '')]
  );

  const row = rows[0];

  if (!row) {
    return null;
  }

  const userId = Number(row.user_id);
  const token = randomBytes(32).toString('hex');

  await connection.execute('DELETE FROM itemshare_password_resets WHERE user_id = ?', [userId]);
  await connection.execute(
    `INSERT INTO itemshare_password_resets (token_hash, user_id, expires_at)
     VALUES (?, ?, NOW() + INTERVAL ${RESET_TOKEN_MINUTES} MINUTE)`,
    [hashEmailToken(token), userId]
  );

  return {
    token,
    userId,
    email: String(row.email || ''),
    displayName: String(row.display_name || ''),
  };
}

/**
 * Sets a new password from a link, once.
 *
 * The row is locked while it happens, so two submits of the same form cannot both win and
 * leave whichever arrived last as the password. Using one link ends every other for that
 * person, which is what makes an older message harmless.
 *
 * @returns {Promise<{userId: number, email: string, displayName: string}|null>} null for
 * an unknown, used or expired link.
 */
export async function consumePasswordReset(connection, token, passwordHash) {
  if (!looksLikeEmailToken(token)) {
    return null;
  }

  await connection.beginTransaction();

  try {
    const [rows] = await connection.execute(
      `SELECT r.user_id, u.display_name, u.email
         FROM itemshare_password_resets r
         JOIN itemshare_users u ON u.id = r.user_id
        WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > NOW()
        FOR UPDATE`,
      [hashEmailToken(token)]
    );

    const row = rows[0];

    if (!row) {
      await connection.rollback();
      return null;
    }

    const userId = Number(row.user_id);

    await connection.execute(
      `INSERT INTO itemshare_passwords (user_id, password_hash) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
      [userId, String(passwordHash)]
    );
    await connection.execute(
      'UPDATE itemshare_password_resets SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL',
      [userId]
    );
    // A password reset is how somebody takes an account back, so every session that was
    // already signed in ends here - in the same transaction as the new hash, so an old
    // session cannot outlive the old password even for a moment. The person's own browser
    // is signed back in by the reset form afterwards, with a fresh session. The operator
    // script does the same in `signOutEverywhere` (resetPassword.js).
    await connection.execute(
      `DELETE FROM itemshare_sessions
        WHERE CAST(JSON_EXTRACT(session_data, '$.user.id') AS UNSIGNED) = ?`,
      [userId]
    );
    await connection.commit();

    return { userId, email: String(row.email || ''), displayName: String(row.display_name || '') };
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

/**
 * Detaches an ESO account from a person without deleting what it has shared.
 *
 * The link is what is removed, not the account: its items, guilds and uploads belong to
 * the account, and it may have been theirs for months. Attaching it again takes it back,
 * and a browsing choice that pointed at it is cleared so the site never browses as an
 * account that is no longer theirs.
 *
 * @returns {Promise<boolean>} whether a link was actually removed
 */
export async function detachAccountFromUser(connection, { userId, accountName }) {
  const [result] = await connection.execute(
    'UPDATE itemshare_accounts SET user_id = NULL WHERE eso_account_name = ? AND user_id = ?',
    [String(accountName || ''), Number(userId)]
  );

  if (!result.affectedRows) {
    return false;
  }

  await connection.execute(
    `UPDATE itemshare_users SET browsing_eso_account_name = ''
      WHERE id = ? AND browsing_eso_account_name = ?`,
    [Number(userId), String(accountName || '')]
  );

  return true;
}

/**
 * The person behind a request from somebody who never signed in.
 *
 * Asking needs three things: the ESO account the request is made from, an address to
 * send the answer to, and a password so the same person can come back and find what they
 * asked for. The password is what makes this an account rather than a one-off row - it
 * writes the same identity and password rows the sign-up form writes, so the ordinary
 * email-and-password sign-in reads it later without knowing where it came from.
 *
 * An address that already signs in with a password belongs to somebody, so it is refused
 * rather than duplicated: a second person for the same address would send the next
 * sign-in to the other one and strand these requests. Beyond that nothing is matched by
 * address, and the ESO account is checked too, because a request from somebody else's
 * character would be a request in their name.
 *
 * @returns {Promise<{created: boolean, userId: number, reason?: 'email'|'account'}>}
 *   created is false when the address already signs in ('email') or the ESO account
 *   belongs to another person ('account'), and neither of those people is signed in
 */
export async function createGuestPerson(
  connection,
  { email, accountName, displayName, passwordHash }
) {
  const address = String(email || '').slice(0, 254);
  const name = String(displayName || accountName || '').slice(0, 96);

  // The address is a sign-in here, so it can only belong to one person.
  const [addresses] = await connection.execute(
    `SELECT user_id FROM itemshare_user_identities
      WHERE provider = 'password' AND provider_user_id = ?`,
    [address]
  );

  if (addresses[0]) {
    return { created: false, userId: Number(addresses[0].user_id), reason: 'email' };
  }

  const [owners] = await connection.execute(
    'SELECT user_id FROM itemshare_accounts WHERE eso_account_name = ?',
    [String(accountName || '')]
  );

  if (owners[0] && owners[0].user_id) {
    return { created: false, userId: Number(owners[0].user_id), reason: 'account' };
  }

  const [inserted] = await connection.execute(
    'INSERT INTO itemshare_users (display_name, email, email_verified) VALUES (?, ?, 0)',
    [name, address]
  );
  const userId = Number(inserted.insertId);

  // The identity is the row itself, not the address: a guest keyed by an email would be
  // claimable by anyone who typed the same address.
  await connection.execute(
    `INSERT INTO itemshare_user_identities
       (provider, provider_user_id, user_id, provider_username, provider_email, email_verified)
     VALUES ('guest', ?, ?, ?, ?, 0)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
    [String(userId), userId, name, address]
  );

  const link = await linkAccountToUser(connection, { accountName: String(accountName || ''), userId });

  if (link === 'conflict') {
    // Somebody claimed the account between the check above and the insert. Undo the person
    // that was made for nothing - every row it came with, not just the person - so a race
    // cannot leave a half-made guest behind.
    await connection.execute('DELETE FROM itemshare_passwords WHERE user_id = ?', [userId]);
    await connection.execute('DELETE FROM itemshare_user_identities WHERE user_id = ?', [userId]);
    await connection.execute('DELETE FROM itemshare_users WHERE id = ?', [userId]);
    return { created: false, userId: 0, reason: 'account' };
  }

  // The way back in: the address and this password, on the ordinary sign-in card. It is
  // stored exactly as the sign-up form stores it, so there is one kind of password row.
  await connection.execute(
    `INSERT INTO itemshare_user_identities
       (provider, provider_user_id, user_id, provider_username, provider_email, email_verified)
     VALUES ('password', ?, ?, ?, ?, 0)
     ON DUPLICATE KEY UPDATE
       user_id = VALUES(user_id),
       provider_username = VALUES(provider_username)`,
    [address, userId, name, address]
  );

  await connection.execute(
    `INSERT INTO itemshare_passwords (user_id, password_hash) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
    [userId, String(passwordHash || '')]
  );

  return { created: true, userId };
}

function viewerAccountNames(accountNames) {
  return [...new Set((accountNames || []).map((name) => String(name || '').trim()).filter(Boolean))];
}

import { filterList } from './filters.js';

function inClause(values) {
  return values.map(() => '?').join(', ');
}

/**
 * The world two guild rows have to agree on.
 *
 * Guild ids are only meaningful inside the same known platform and megaserver.
 * Unknown server metadata must not grant access to another world's items.
 */
function sameWorldSql(left, right) {
  return `${left}.world_name = ${right}.world_name AND ${left}.world_name <> ''
          AND ${left}.platform = ${right}.platform AND ${left}.platform > 0`;
}

/**
 * The one guild row a link points at: same id, same world. Matching the pair keeps a
 * single join, so an item never appears twice because two worlds share a guild id.
 */
function guildNameJoin(linkAlias) {
  return `LEFT JOIN itemshare_guilds g
              ON g.guild_id = ${linkAlias}.guild_id
             AND g.platform = ${linkAlias}.platform
             AND g.world_name = ${linkAlias}.world_name`;
}

/** Guilds any of the viewer's ESO accounts belongs to. */
export async function getViewerGuilds(connection, accountNames) {
  const names = viewerAccountNames(accountNames);
  if (names.length === 0) {
    return [];
  }

  const [rows] = await connection.execute(
    `SELECT ag.guild_id, COALESCE(g.guild_name, '') AS guild_name,
            ag.platform, ag.world_name
       FROM itemshare_account_guilds ag
       LEFT JOIN itemshare_accounts va ON va.eso_account_name = ag.account_name
                                      AND va.platform = ag.platform AND va.world_name = ag.world_name
       ${guildNameJoin('ag')}
      WHERE ag.account_name IN (${inClause(names)}) AND ag.platform > 0 AND ag.world_name <> ''
        AND (va.eso_account_name IS NOT NULL OR ag.granted_code_id IS NOT NULL)
      GROUP BY ag.guild_id, g.guild_name, ag.platform, ag.world_name
      ORDER BY guild_name ASC, ag.guild_id ASC`,
    names
  );
  return rows;
}

// --------------------------------------------------------------- guild codes
// A member of a guild hands out a code; somebody who already has an account here types
// it and is given that guild. The guild's id, platform and world come from the code,
// because a guild id on its own names several different guilds.

/**
 * One of the person's own guilds, as a code would need it.
 *
 * The form names a guild; this is where it is checked, against the accounts that actually
 * belong to the person. A hand-written form cannot make a code for somebody else's guild.
 * Memberships granted by a code count, so an invited member can invite further.
 *
 * @returns {Promise<{guild_id:number, guild_name:string, platform:number, world_name:string}|null>}
 */
export async function findOwnGuild(connection, userId, { guildId, platform, worldName }) {
  const [rows] = await connection.execute(
    `SELECT ag.guild_id, COALESCE(g.guild_name, '') AS guild_name,
            ag.platform, ag.world_name
       FROM itemshare_account_guilds ag
       JOIN itemshare_accounts a ON a.eso_account_name = ag.account_name AND a.user_id = ?
       ${guildNameJoin('ag')}
      WHERE ag.guild_id = ? AND ag.platform = ? AND ag.world_name = ?
      LIMIT 1`,
    [Number(userId), Number(guildId), Number(platform), String(worldName)]
  );

  return rows[0] || null;
}

/**
 * A new code for one guild, and what it is for.
 *
 * The code is the only thing the other person needs, so a collision is a retry rather
 * than an error - and the unique key on the column is what makes the retry correct even
 * if two people make a code at the same moment.
 *
 * @returns {Promise<{code:string, guildName:string, platform:number, worldName:string}>}
 */
export async function createGuildCode(connection, { userId, guild }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newGuildCode();

    try {
      await connection.execute(
        `INSERT INTO itemshare_guild_codes
           (code, guild_id, guild_name, platform, world_name, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          code,
          Number(guild.guild_id),
          String(guild.guild_name || ''),
          Number(guild.platform) || 0,
          String(guild.world_name || ''),
          Number(userId),
        ]
      );

      return {
        code,
        guildName: String(guild.guild_name || ''),
        platform: Number(guild.platform) || 0,
        worldName: String(guild.world_name || ''),
      };
    } catch (error) {
      if (error && error.code === 'ER_DUP_ENTRY') {
        continue;
      }

      throw error;
    }
  }

  throw new Error('Could not make a code: every try collided, which should not happen.');
}

/** Every code one person has made, newest first, with how many people used it. */
export async function listGuildCodes(connection, userId) {
  const [rows] = await connection.execute(
    `SELECT c.code, c.guild_name, c.platform, c.world_name, c.created_at,
            COUNT(r.id) AS redemptions
       FROM itemshare_guild_codes c
       LEFT JOIN itemshare_guild_code_redemptions r ON r.code_id = c.id
      WHERE c.created_by_user_id = ?
      GROUP BY c.id, c.code, c.guild_name, c.platform, c.world_name, c.created_at
      ORDER BY c.created_at DESC, c.id DESC`,
    [Number(userId)]
  );

  return rows.map((row) => ({
    code: String(row.code || ''),
    guildName: String(row.guild_name || ''),
    platform: Number(row.platform) || 0,
    worldName: String(row.world_name || ''),
    createdAt: row.created_at || null,
    redemptions: Number(row.redemptions || 0),
  }));
}

/**
 * Deletes one of the person's codes and takes back the guild access it gave.
 *
 * Only rows this code wrote are removed. A member whose own upload has since reported the
 * guild had `granted_code_id` cleared, so their membership is the game's by then and is
 * left alone - revoking an invitation must not claim somebody left a guild they are in.
 *
 * Ownership is part of the lookup, so knowing the eight characters is not enough to revoke
 * a code somebody else made.
 *
 * @returns {Promise<{status:'unknown'|'revoked', code?:string, guildName?:string,
 *   worldName?:string, platform?:number, accounts:number}>}
 */
export async function revokeGuildCode(connection, { userId, code }) {
  const [found] = await connection.execute(
    `SELECT id, code, guild_name, platform, world_name
       FROM itemshare_guild_codes
      WHERE code = ? AND created_by_user_id = ?
      LIMIT 1`,
    [normalizeGuildCode(code), Number(userId)]
  );

  const row = found[0];

  if (!row) {
    return { status: 'unknown', accounts: 0 };
  }

  const [granted] = await connection.execute(
    'DELETE FROM itemshare_account_guilds WHERE granted_code_id = ?',
    [row.id]
  );

  await connection.execute(
    'DELETE FROM itemshare_guild_code_redemptions WHERE code_id = ?',
    [row.id]
  );

  await connection.execute('DELETE FROM itemshare_guild_codes WHERE id = ?', [row.id]);

  return {
    status: 'revoked',
    code: String(row.code || ''),
    guildName: String(row.guild_name || ''),
    worldName: String(row.world_name || ''),
    platform: Number(row.platform) || 0,
    accounts: Number(granted && granted.affectedRows) || 0,
  };
}

/**
 * Takes one code, and gives the person the guild it names.
 *
 * The membership is written to one of the person's own accounts - the one they browse as
 * when it is theirs, otherwise the oldest - and carries the code's id, which is what keeps
 * the next upload from replacing it.
 *
 * @returns {Promise<{status:'unknown'|'no-account'|'already'|'joined', guildName?:string, worldName?:string, platform?:number, accountName?:string}>}
 */
export async function redeemGuildCode(connection, { userId, code, accounts = [], accountName = '' }) {
  const [found] = await connection.execute(
    `SELECT id, code, guild_id, guild_name, platform, world_name
       FROM itemshare_guild_codes WHERE code = ? LIMIT 1`,
    [String(code || '')]
  );

  const row = found[0];

  if (!row) {
    return { status: 'unknown' };
  }

  const names = (accounts || []).filter(Boolean);

  // Nothing can be shown to somebody the site knows no account for, so this is a refusal
  // with an instruction rather than a membership written to nobody.
  if (names.length === 0) {
    return { status: 'no-account', guildName: String(row.guild_name || '') };
  }

  const [joined] = await connection.execute(
    `SELECT 1 AS ok FROM itemshare_account_guilds
      WHERE guild_id = ? AND platform = ? AND world_name = ?
        AND account_name IN (${inClause(names)})
      LIMIT 1`,
    [row.guild_id, row.platform, row.world_name, ...names]
  );

  if (joined.length > 0) {
    return {
      status: 'already',
      guildName: String(row.guild_name || ''),
      worldName: String(row.world_name || ''),
      platform: Number(row.platform) || 0,
    };
  }

  const chosen = names.includes(accountName) ? accountName : names[0];

  await connection.execute(
    `INSERT INTO itemshare_account_guilds
       (account_name, guild_id, platform, world_name, granted_code_id)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE granted_code_id = IFNULL(granted_code_id, VALUES(granted_code_id))`,
    [chosen, row.guild_id, row.platform, row.world_name, row.id]
  );

  await connection.execute(
    `INSERT IGNORE INTO itemshare_guild_code_redemptions (code_id, user_id, account_name)
     VALUES (?, ?, ?)`,
    [row.id, Number(userId), chosen]
  );

  return {
    status: 'joined',
    guildName: String(row.guild_name || ''),
    worldName: String(row.world_name || ''),
    platform: Number(row.platform) || 0,
    accountName: chosen,
  };
}

/**
 * Items the viewer may see: the ones offered to a guild they belong to, plus —
 * for the owner only — their own items with no guild link at all.
 *
 * Without the second branch an unstamped share is invisible to everybody,
 * including the person who shared it, which is exactly what happened to 27 of one
 * owner's 28 items. The extra branch leaks nothing: it is keyed on the viewer's
 * own account names, so an unlinked item still never reaches anyone else.
 */
function visibleItemsFrom(names) {
  return `
       FROM itemshare_shared_items i
       LEFT JOIN itemshare_shared_item_guilds ig ON ig.item_id = i.id
       LEFT JOIN itemshare_account_guilds viewer
              ON viewer.guild_id = ig.guild_id
             AND viewer.account_name IN (${inClause(names)})
             AND ${sameWorldSql('viewer', 'ig')}
             AND (viewer.granted_code_id IS NOT NULL
                  OR EXISTS (SELECT 1 FROM itemshare_accounts va
                               WHERE va.eso_account_name = viewer.account_name
                                 AND va.platform = viewer.platform AND va.world_name = viewer.world_name))
       ${guildNameJoin('ig')}
       LEFT JOIN itemshare_item_icons icon ON icon.icon_key = i.icon_key`;
}

/** Guild overlap, or the owner's own entry that has no guild overlap to find. */
function itemsVisibilityClause(names) {
  return `(viewer.account_name IS NOT NULL
           OR (ig.guild_id IS NULL AND i.account_name IN (${inClause(names)})))`;
}

function visibleAlwaysShareFrom(names) {
  return `
       FROM itemshare_always_share a
       LEFT JOIN itemshare_always_share_guilds ag ON ag.always_share_id = a.id
       LEFT JOIN itemshare_account_guilds viewer
              ON viewer.guild_id = ag.guild_id
             AND viewer.account_name IN (${inClause(names)})
             AND ${sameWorldSql('viewer', 'ag')}
             AND (viewer.granted_code_id IS NOT NULL
                  OR EXISTS (SELECT 1 FROM itemshare_accounts va
                               WHERE va.eso_account_name = viewer.account_name
                                 AND va.platform = viewer.platform AND va.world_name = viewer.world_name))
       ${guildNameJoin('ag')}
       LEFT JOIN itemshare_item_icons icon ON icon.icon_key = a.icon_key`;
}

function alwaysShareVisibilityClause(names) {
  return `(viewer.account_name IS NOT NULL
           OR (ag.guild_id IS NULL AND a.account_name IN (${inClause(names)})))`;
}

/**
 * Where one viewer's inventory list is read from.
 *
 * An account always uses the guild rule. No known guilds means no matching shares.
 * The unrestricted branch is only for the public preview with no selected account.
 */
function inventoryScope(names, restrict) {
  if (!restrict) {
    return {
      from: `
       FROM itemshare_shared_items i
       LEFT JOIN itemshare_shared_item_guilds ig ON ig.item_id = i.id
       ${guildNameJoin('ig')}
       LEFT JOIN itemshare_item_icons icon ON icon.icon_key = i.icon_key`,
      clause: '1 = 1',
      params: [],
    };
  }

  return {
    from: visibleItemsFrom(names),
    clause: itemsVisibilityClause(names),
    params: [...names, ...names],
  };
}

/** The same, for the standing offers. */
function alwaysShareScope(names, restrict) {
  if (!restrict) {
    return {
      from: `
       FROM itemshare_always_share a
       LEFT JOIN itemshare_always_share_guilds ag ON ag.always_share_id = a.id
       ${guildNameJoin('ag')}
       LEFT JOIN itemshare_item_icons icon ON icon.icon_key = a.icon_key`,
      clause: '1 = 1',
      params: [],
    };
  }

  return {
    from: visibleAlwaysShareFrom(names),
    clause: alwaysShareVisibilityClause(names),
    params: [...names, ...names],
  };
}

/**
 * Item types and owner accounts present in what the viewer can see, used to fill
 * the filter controls. Not affected by the active filters.
 */
export async function getViewerFacets(connection, accountNames) {
  const names = viewerAccountNames(accountNames);
  const scope = inventoryScope(names, names.length > 0);

  // The facets have to follow the same visibility rule as the grid, or a type
  // that only appears on an unattributed entry cannot be filtered to.
  const [types] = await connection.execute(
    `SELECT i.item_type_name AS name, COUNT(DISTINCT i.id) AS total
     ${scope.from}
      WHERE i.item_type_name <> '' AND ${scope.clause}
      GROUP BY i.item_type_name
      ORDER BY i.item_type_name ASC`,
    scope.params
  );

  const [owners] = await connection.execute(
    `SELECT DISTINCT i.account_name AS name
     ${scope.from}
      WHERE ${scope.clause}
      ORDER BY i.account_name ASC`,
    scope.params
  );

  return {
    types: types.map((row) => ({ name: row.name, total: Number(row.total) || 0 })),
    owners: owners.map((row) => row.name),
  };
}

/**
 * Shared items offered to any guild the viewer belongs to, grouped by item type
 * and alphabetical inside each type. Ownership comes from the item's own account,
 * visibility from the guild overlap.
 */
/**
 * The three sort orders the table offers, and nothing else: an odd ?sort= in the
 * address bar falls back to the type grouping rather than reaching the query.
 */
function orderFor(alias, sort, dir) {
  const direction = String(dir || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  if (sort === 'added') {
    return `${alias}.first_seen_at ${direction}, ${alias}.item_name ASC, ${alias}.account_name ASC`;
  }
  if (sort === 'name') {
    return `${alias}.item_name ${direction}, ${alias}.account_name ASC`;
  }
  return `${alias}.item_type_name ASC, ${alias}.item_name ASC, ${alias}.account_name ASC`;
}

/**
 * "Shared in the last N days", as a SQL condition. The number is inlined only after
 * being clamped to an integer, because an INTERVAL placeholder is the one piece of
 * this syntax that MariaDB and MySQL do not agree about.
 */
function addedClause(alias, added) {
  const days = Math.trunc(Number(added));

  if (!Number.isFinite(days) || days <= 0) {
    return '';
  }

  return `${alias}.first_seen_at >= (NOW() - INTERVAL ${Math.min(days, 3650)} DAY)`;
}

/**
 * How much of each row is already spoken for. Deliberately a second query: a
 * correlated subquery inside a grouped select depends on functional-dependency
 * support that differs between the servers this may meet, and one extra round trip
 * per page is cheaper than a query that only works on some of them.
 */
async function attachRequestCounts(connection, rows, kind) {
  if (!rows || rows.length === 0) {
    return rows;
  }

  for (const row of rows) {
    row.reserved = 0;
    row.delivered = 0;
    row.request_count = 0;
    row.pending_requests = [];
    row.draft_count = 0;
  }

  const ids = rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));

  if (ids.length === 0) {
    return rows;
  }

  const column = kind === 'offer' ? 'always_share_id' : 'shared_item_id';
  const [counts] = await connection.execute(
    `SELECT ${column} AS target_id,
            COALESCE(SUM(CASE WHEN ${holdingSql()} THEN quantity ELSE 0 END), 0) AS reserved,
            COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS request_count,
            COALESCE(SUM(CASE WHEN status = 'draft' AND expires_at > NOW() THEN 1 ELSE 0 END), 0)
              AS draft_count,
            MAX(CASE WHEN status = 'pending' THEN submitted_at END) AS last_sent_at
       FROM itemshare_requests
      WHERE item_kind = ? AND status IN ('draft', 'pending')
        AND ${column} IN (${inClause(ids)})
      GROUP BY ${column}`,
    [kind, ...ids]
  );

  const byId = new Map(counts.map((row) => [Number(row.target_id), row]));

  // Who is waiting, one entry per request, so the count on the owner's row and the list
  // behind its hover cannot disagree: both come from these rows.
  const [pending] = await connection.execute(
    `SELECT ${column} AS target_id, requester_account_name, quantity, quantity_requested
       FROM itemshare_requests
      WHERE item_kind = ? AND status = 'pending'
        AND ${column} IN (${inClause(ids)})
      ORDER BY submitted_at ASC, id ASC`,
    [kind, ...ids]
  );

  const pendingByItem = new Map();

  for (const row of pending) {
    const id = Number(row.target_id);
    const waiting = pendingByItem.get(id) || [];
    waiting.push({
      requester: String(row.requester_account_name || 'Somebody'),
      // What they asked for, which is what the owner is being asked to mail; a short
      // handover leaves the request pending with a smaller remaining `quantity`.
      quantity: Number(row.quantity_requested) || Number(row.quantity) || 1,
    });
    pendingByItem.set(id, waiting);
  }

  for (const row of rows) {
    const count = byId.get(Number(row.id));
    row.reserved = Number(count?.reserved || 0);
    row.request_count = Number(count?.request_count || 0);
    row.pending_requests = pendingByItem.get(Number(row.id)) || [];
    row.draft_count = Number(count?.draft_count || 0);
    row.last_sent_at = count?.last_sent_at || null;
  }

  return kind === 'inventory' ? attachDeliveredCounts(connection, rows) : rows;
}

/**
 * Copies that have already been mailed but are still inside the uploaded total.
 *
 * A handover leaves the owner's bag, so the next upload's count already excludes it
 * and this has to evaluate to zero from that upload on. Until then the copies are
 * subtracted, because the row's count is a photograph of a moment and the mail
 * happened after it. Comparing the two stamps is what keeps one delivery from being
 * taken off twice, which would lose the stock for good.
 */
async function attachDeliveredCounts(connection, rows) {
  const ids = (rows || []).map((row) => Number(row.id)).filter((id) => Number.isFinite(id));

  if (ids.length === 0) {
    return rows;
  }

  const [delivered] = await connection.execute(
    `SELECT r.shared_item_id AS target_id,
            COALESCE(SUM(r.quantity), 0) AS delivered
       FROM itemshare_requests r
       JOIN itemshare_shared_items i ON i.id = r.shared_item_id
       LEFT JOIN itemshare_uploads up ON up.id = i.upload_id
      WHERE r.item_kind = 'inventory' AND r.status = 'fulfilled'
        AND (up.uploaded_at IS NULL OR r.fulfilled_at > up.uploaded_at)
        AND r.shared_item_id IN (${inClause(ids)})
      GROUP BY r.shared_item_id`,
    ids
  );

  const byId = new Map(
    delivered.map((row) => [Number(row.target_id), Number(row.delivered) || 0])
  );

  for (const row of rows) {
    row.delivered = byId.get(Number(row.id)) || 0;
  }

  return rows;
}

/**
 * How long a row that has just run out stays on screen. The page fades it over the
 * same window, so the row goes rather than vanishing; app.js mirrors this number.
 */
export const EXHAUSTED_ROW_LINGER_MS = 5000;

/**
 * Drops rows that have nothing left to offer, after a last look.
 *
 * A row is finished when every copy is held by requests that were actually sent -
 * not while somebody is still picking, because a draft hold can lapse and the copy
 * come back. It is kept for a few seconds after the last send so the page can fade
 * it and the rows beneath close the gap, then it stops being sent at all.
 */
export function dropExhaustedRows(rows, now = Date.now()) {
  return (rows || []).filter((row) => {
    const free =
      (Number(row.item_count) || 0) -
      (Number(row.reserved) || 0) -
      (Number(row.delivered) || 0);

    if (free > 0 || Number(row.draft_count) > 0) {
      return true;
    }

    const lastSent = row.last_sent_at ? new Date(row.last_sent_at).getTime() : 0;
    const remaining = lastSent ? EXHAUSTED_ROW_LINGER_MS - (now - lastSent) : 0;

    row.exhausted = Math.max(0, Math.round(remaining));

    return remaining > 0;
  });
}

/**
 * How many copies of a row one person may end up holding, their own basket
 * included. Free copies plus what they have already reserved is the whole row less
 * everybody else's holds.
 */
export function requestRoom({ total, reserved, delivered = 0, alreadyHeld = 0 }) {
  const free = Math.max(
    0,
    (Number(total) || 0) - (Number(reserved) || 0) - (Number(delivered) || 0)
  );
  return free + Math.max(0, Number(alreadyHeld) || 0);
}

/**
 * The count a basket row ends up with after asking again for the same item.
 *
 * The number the person picks is how many more they want, not a new total: asking for
 * one, then one again, leaves a single row holding two. It never goes past what the row
 * can give, which is the free copies plus whatever is already in that basket.
 */
export function combineQuantity({ wanted, alreadyHeld = 0, room }) {
  const held = Math.max(0, Math.trunc(Number(alreadyHeld) || 0));
  const asked = Math.max(1, Math.trunc(Number(wanted) || 1));
  return Math.min(held + asked, Math.max(Number(room) || 0, held));
}

/** This person's live draft for one row, if they already have one. */
async function ownDraftForTarget(connection, userId, itemKind, targetId) {
  const column = itemKind === 'offer' ? 'always_share_id' : 'shared_item_id';
  const [rows] = await connection.execute(
    `SELECT id, quantity
       FROM itemshare_requests
      WHERE requester_user_id = ? AND item_kind = ? AND ${column} = ?
        AND status = 'draft' AND expires_at > NOW()
      ORDER BY id ASC
      LIMIT 1`,
    [Number(userId), itemKind, Number(targetId)]
  );

  return rows[0] || null;
}

/**
 * How much of each visible row is already in *this viewer's* basket. The total held
 * count is everybody's; this is what the viewer may ask for on top of, because
 * asking again tops their own row up instead of starting another.
 *
 * Read by person, not by the account name on the row. The basket, the history and the
 * top-up a repeat ask does all go by `requester_user_id`, so this has to as well or
 * the list and the Your requests tab can disagree about the same hold: a draft made
 * before an ESO account changed hands was announced as "in your basket" to the new
 * owner of the name, whose basket did not contain it and who could neither send nor
 * remove it. A visitor with no person row of their own holds nothing.
 */
async function attachViewerDrafts(connection, rows, viewerUserId) {
  for (const row of rows || []) {
    row.my_draft_quantity = 0;
  }

  const userId = Number(viewerUserId) || 0;
  const ids = (rows || []).map((row) => Number(row.id)).filter(Number.isFinite);

  if (userId <= 0 || ids.length === 0) {
    return rows;
  }

  const [drafts] = await connection.execute(
    `SELECT shared_item_id AS target_id, COALESCE(SUM(quantity), 0) AS held
       FROM itemshare_requests
      WHERE item_kind = 'inventory' AND status = 'draft' AND expires_at > NOW()
        AND requester_user_id = ?
        AND shared_item_id IN (${inClause(ids)})
      GROUP BY shared_item_id`,
    [userId, ...ids]
  );

  const byId = new Map(drafts.map((row) => [Number(row.target_id), Number(row.held) || 0]));

  for (const row of rows || []) {
    row.my_draft_quantity = byId.get(Number(row.id)) || 0;
  }

  return rows;
}

export async function getSharedItemsForViewer(
  connection,
  accountNames,
  {
    type = '',
    owner = '',
    search = '',
    added = '',
    sort = '',
    dir = '',
    limit = 500,
    viewerUserId = 0,
  } = {}
) {
  const names = viewerAccountNames(accountNames);
  const scope = inventoryScope(names, names.length > 0);

  const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 500));
  const filters = [scope.clause];
  const params = [...scope.params];

  // A filter can hold several values at once: each one narrows the list instead of
  // replacing the last choice, so "Weapon" and "Armor" together show both.
  const types = filterList(type);
  const owners = filterList(owner);

  if (types.length > 0) {
    filters.push(`i.item_type_name IN (${inClause(types)})`);
    params.push(...types);
  }
  if (owners.length > 0) {
    filters.push(`i.account_name IN (${inClause(owners)})`);
    params.push(...owners);
  }
  if (search) {
    filters.push('i.item_name LIKE ?');
    params.push(`%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`);
  }

  const recent = addedClause('i', added);
  if (recent) {
    filters.push(recent);
  }

  // Always present: visibility is not optional, only the filters are.
  const where = `WHERE ${filters.join(' AND ')}`;

  const [rows] = await connection.execute(
    `SELECT i.id,
            i.item_name,
            i.item_id,
            i.item_key_hash,
            i.icon_key,
            i.item_count,
            i.held_quantity,
            i.reserve_quantity,
            i.quality,
            i.quality_name,
            i.item_type_name,
            i.trait,
            i.set_name,
            i.enchant_name,
            i.style_name,
            i.required_level,
            i.required_cp,
            i.armor_type,
            i.weapon_type,
            i.apparel_slot,
            i.equip_type,
            i.location_label,
            i.last_dumped_at,
            i.first_seen_at,
            DATE_FORMAT(i.first_seen_at, '%Y-%m-%dT%H:%i:%sZ') AS first_seen_at_iso,
            i.account_name,
            i.character_name,
            (icon.icon_key IS NOT NULL) AS has_icon,
            GROUP_CONCAT(DISTINCT g.guild_name ORDER BY g.guild_name SEPARATOR ', ') AS guild_names
       ${scope.from}
       ${where}
      GROUP BY i.id, i.item_name, i.item_id, i.item_key_hash, i.icon_key, i.item_count,
               i.held_quantity, i.reserve_quantity, i.quality,
               i.quality_name, i.item_type_name, i.trait, i.set_name, i.enchant_name,
               i.style_name, i.required_level, i.required_cp, i.armor_type, i.weapon_type,
               i.apparel_slot, i.equip_type, i.location_label, i.last_dumped_at, i.first_seen_at,
               i.account_name, i.character_name, icon.icon_key
      ORDER BY ${orderFor('i', sort, dir)}
      LIMIT ${safeLimit}`,
    params
  );

  const counted = dropExhaustedRows(await attachRequestCounts(connection, rows, 'inventory'));
  return attachViewerDrafts(connection, counted, viewerUserId);
}

/**
 * Standing offers visible to the viewer: joined through the guilds the item is
 * offered to, exactly like the inventory list. An offer carries no count of its own and
 * the file no longer repeats the item in `sharedItems`, so the row says nothing about
 * stock - it is a promise for one copy at a time.
 */
export async function getAlwaysShareForViewer(
  connection,
  accountNames,
  { type = '', owner = '', search = '', added = '', sort = '', dir = '', limit = 500 } = {}
) {
  const names = viewerAccountNames(accountNames);
  const scope = alwaysShareScope(names, names.length > 0);
  const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 500));
  const filters = [scope.clause];
  const params = [...scope.params];

  const types = filterList(type);
  const owners = filterList(owner);

  if (types.length > 0) {
    filters.push(`a.item_type_name IN (${inClause(types)})`);
    params.push(...types);
  }
  if (owners.length > 0) {
    filters.push(`a.account_name IN (${inClause(owners)})`);
    params.push(...owners);
  }
  if (search) {
    filters.push('a.item_name LIKE ?');
    params.push(`%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`);
  }

  const recent = addedClause('a', added);
  if (recent) {
    filters.push(recent);
  }

  const where = `WHERE ${filters.join(' AND ')}`;

  const [rows] = await connection.execute(
    `SELECT a.id,
            a.item_name,
            a.item_id,
            a.item_key_hash,
            a.icon_key,
            a.quality,
            a.item_type_name,
            a.trait,
            a.set_name,
            a.held_quantity,
            a.reserve_quantity,
            a.first_added_at,
            a.first_seen_at,
            DATE_FORMAT(a.first_seen_at, '%Y-%m-%dT%H:%i:%sZ') AS first_seen_at_iso,
            a.account_name,
            a.character_name,
            (icon.icon_key IS NOT NULL) AS has_icon,
            GROUP_CONCAT(DISTINCT g.guild_name ORDER BY g.guild_name SEPARATOR ', ') AS guild_names
       ${scope.from}
       ${where}
      GROUP BY a.id, a.item_name, a.item_id, a.item_key_hash, a.icon_key, a.quality, a.item_type_name,
               a.trait, a.set_name, a.held_quantity, a.reserve_quantity, a.first_added_at, a.first_seen_at,
               a.account_name, a.character_name, icon.icon_key
      ORDER BY ${orderFor('a', sort, dir)}
      LIMIT ${safeLimit}`,
    params
  );

  return attachRequestCounts(connection, rows, 'offer');
}

/**
 * Links an ESO account to the signed-in person, with the platform and megaserver it plays
 * on.
 *
 * The platform and world are only written when they were actually given: the demo's own
 * account is re-attached by the remove handler with no form behind it, and that must not
 * wipe what the demo's file already recorded.
 * @returns {Promise<'linked'|'already-linked'|'conflict'>}
 */
export async function linkAccountToUser(
  connection,
  { accountName, userId, platform = 0, worldName = '' }
) {
  const world = worldOf({ platform, worldName });
  const hasServer = world.platform > 0 || Boolean(world.worldName);

  const [rows] = await connection.execute(
    'SELECT user_id FROM itemshare_accounts WHERE eso_account_name = ?',
    [accountName]
  );

  const existing = rows[0];

  if (existing && existing.user_id && Number(existing.user_id) !== Number(userId)) {
    return 'conflict';
  }

  if (existing) {
    if (hasServer) {
      await connection.execute(
        'UPDATE itemshare_accounts SET user_id = ?, platform = ?, world_name = ? WHERE eso_account_name = ?',
        [userId, world.platform, world.worldName, accountName]
      );
    } else {
      await connection.execute(
        'UPDATE itemshare_accounts SET user_id = ? WHERE eso_account_name = ?',
        [userId, accountName]
      );
    }

    return 'already-linked';
  }

  await connection.execute(
    'INSERT INTO itemshare_accounts (eso_account_name, user_id, platform, world_name) VALUES (?, ?, ?, ?)',
    [accountName, userId, world.platform, world.worldName]
  );
  return 'linked';
}

/**
 * Every platform and server already recorded against an account, for the form's choices.
 * A name attached before the form existed has neither, and offers nothing.
 */
export async function listAccountServers(connection) {
  const [rows] = await connection.execute(
    `SELECT platform, world_name FROM itemshare_accounts
      WHERE platform > 0 OR world_name <> ''
      ORDER BY platform ASC, world_name ASC`
  );

  return rows.map((row) => ({
    platform: Number(row.platform) || 0,
    worldName: String(row.world_name || ''),
  }));
}

// -------------------------------------------------------------------- requests
// A request reserves part of a stack until the owner hands it over. Nothing here
// talks to the owner yet; what it does do is keep the arithmetic honest, so the
// quantity someone is offered to ask for is the quantity that is really left.

/** Cancels one pending request, with a reason the requester can read. */
async function cancelRequest(connection, requestId, reason) {
  // The form link in the owner's email dies with the request: answering it after
  // somebody else cancelled the row would be answering something that is over.
  await connection.execute(
    `UPDATE itemshare_requests
        SET status = 'cancelled',
            status_reason = ?,
            closed_at = CURRENT_TIMESTAMP,
            email_token_hash = '',
            email_token_expires_at = NULL
      WHERE id = ? AND status = 'pending'`,
    [reason, requestId]
  );
}

/**
 * What counts as holding stock: a submitted request, or a draft that has not
 * lapsed yet.
 *
 * The deadline is part of the condition rather than something the sweeper is
 * trusted to have applied, because a reservation that has timed out has to stop
 * holding a copy the second it times out. The sweeper runs on an interval; between
 * two runs the arithmetic still has to be right.
 */
function holdingSql(alias = '') {
  const prefix = alias ? `${alias}.` : '';
  return `(${prefix}status = 'pending' OR (${prefix}status = 'draft' AND ${prefix}expires_at > NOW()))`;
}

/** How long a draft is held, in whole minutes. */
export const DEFAULT_HOLD_MINUTES = 5;

function holdMinutes(value) {
  const minutes = Math.trunc(Number(value));
  const wanted = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_HOLD_MINUTES;
  return Math.min(Math.max(wanted, 1), 120);
}

/**
 * One clock for one person's basket. Every add and every removal calls this, so all
 * of their drafts lapse together and the page counts one number down instead of
 * one per row. Inlined rather than bound because a placeholder inside INTERVAL is
 * the one piece of this syntax MariaDB and MySQL disagree about.
 */
async function resetBasketClock(connection, userId, minutes) {
  await connection.execute(
    `UPDATE itemshare_requests
        SET expires_at = (NOW() + INTERVAL ${holdMinutes(minutes)} MINUTE)
      WHERE requester_user_id = ? AND status = 'draft'`,
    [Number(userId)]
  );
}

/**
 * What a person is currently holding but has not sent: the rows, the copies, and
 * how many seconds are left on the shared clock.
 */
export async function getDraftBasket(connection, userId, minutes = DEFAULT_HOLD_MINUTES) {
  const [[row]] = await connection.execute(
    `SELECT COUNT(*) AS items,
            COALESCE(SUM(quantity), 0) AS quantity,
            TIMESTAMPDIFF(SECOND, NOW(), MIN(expires_at)) AS seconds_left
       FROM itemshare_requests
      WHERE requester_user_id = ? AND status = 'draft' AND expires_at > NOW()`,
    [Number(userId)]
  );

  return {
    count: Number(row?.items || 0),
    quantity: Number(row?.quantity || 0),
    secondsLeft: Math.max(0, Number(row?.seconds_left || 0)),
    holdMinutes: holdMinutes(minutes),
  };
}

/**
 * Gives a person the live holds that were made from an account they own.
 *
 * A draft records the ESO account it was asked from, and that account name has one
 * owner. When the owner changes - a guest account is created, an account is detached
 * and attached again, or a sign-in ends up as a different person row than the draft was
 * filed under - the draft keeps pointing at the person it was written for. The copy is
 * then held where nobody can act on it: the row says it is theirs, the owner's email
 * will tell them to mail it to that account, and the basket, the Send button and Cancel
 * all still disagree.
 *
 * So the hold follows the name. Every live draft made from an account this person owns
 * becomes theirs, which is who the copy would be mailed to anyway. A draft that has
 * already lapsed is left for the sweeper - those copies are free again on their own -
 * and a draft that is already theirs is not touched.
 *
 * @returns {Promise<number>} how many drafts changed hands
 */
export async function claimHoldsForOwnedAccounts(connection, { userId }) {
  const personId = Number(userId) || 0;

  if (personId <= 0) {
    return 0;
  }

  const [result] = await connection.execute(
    `UPDATE itemshare_requests r
       JOIN itemshare_accounts a
         ON a.eso_account_name = r.requester_account_name AND a.user_id = ?
        SET r.requester_user_id = ?
      WHERE r.status = 'draft'
        AND r.expires_at > NOW()
        AND (r.requester_user_id IS NULL OR r.requester_user_id <> ?)`,
    [personId, personId, personId]
  );

  const claimed = Number(result.affectedRows || 0);

  if (claimed > 0) {
    // The clock started when it was asked for and ran while nobody could act on it, so
    // the basket arrives with a full window instead of with whatever was left.
    await resetBasketClock(connection, personId, DEFAULT_HOLD_MINUTES);
  }

  return claimed;
}

/**
 * Sends everything in one person's basket at once.
 *
 * Only drafts that are still live are sent: one that already lapsed is left for the
 * sweeper to mark expired, because it was never a promise and nobody should be told
 * it is waiting.
 */
export async function submitDrafts(connection, { userId }) {
  // UTC, so the one moment a request was sent means the same thing read from any
  // machine. `NOW()` would record the server's local wall clock in a DATETIME column,
  // which has no time zone to recover it from later.
  const [result] = await connection.execute(
    `UPDATE itemshare_requests
        SET status = 'pending', submitted_at = UTC_TIMESTAMP(), expires_at = NULL
      WHERE requester_user_id = ? AND status = 'draft' AND expires_at > NOW()`,
    [Number(userId)]
  );

  return Number(result.affectedRows || 0);
}

/**
 * Releases every draft whose deadline has passed, whoever is or is not looking at
 * the site. Called on a timer by the server, so a person who closed the tab still
 * gives their items back.
 *
 * @returns {Promise<number>} how many reservations were released
 */
export async function expireDueDrafts(connection) {
  const [result] = await connection.execute(
    `UPDATE itemshare_requests
        SET status = 'expired',
            status_reason = 'The request was not sent within the time allowed, so the items went back to being available.',             closed_at = CURRENT_TIMESTAMP
      WHERE status = 'draft' AND expires_at <= NOW()`
  );

  return Number(result.affectedRows || 0);
}

/**
 * Puts requests whose hold ran out back where an operator wants them.
 *
 * An expired draft was never sent, so no owner was ever told about it. A reopened row can
 * go one of two ways, and the difference is what the owner knows:
 *
 * - `basket` (the default) holds the copies again and puts the row back in the person's
 *   basket, where Send requests is. That is what "active" means everywhere else in this
 *   file - the count in `holdingSql` - and it asks nobody for anything yet.
 * - `pending` files it as if the basket had been sent: it counts against the owner's stack
 *   and waits in their list, with `submitted_at` recorded the way `submitDrafts` records
 *   it, so the requester's history reads a request rather than a basket row. Nothing is
 *   emailed, which is the whole point of doing it here: the owner finds it the next time
 *   they look at their list.
 *
 * Every row is measured against what is free now, because the world moves while a hold is
 * gone: the owner may have re-uploaded a smaller stack, or somebody else may hold the
 * copies. A row that no longer fits is skipped and reported, never half-reopened, and a
 * row that only partly fits comes back with the copies that are really there.
 *
 * The row an item hangs off can change while a hold is gone - the same item moved to
 * another character, or was shared again - so a request whose id no longer resolves is
 * followed to the row the item lives under now, by owner and item key, exactly as
 * reconcileRequestsForOwner follows the requests that are still open. Only an item the
 * owner really stopped sharing is skipped.
 *
 * @param {object} connection a mysql2 connection
 * @param {{ids?: number[], requesterEmail?: string, accountName?: string, itemText?: string,
 *   limit?: number, minutes?: number, dryRun?: boolean, target?: 'basket'|'pending'}} [options]
 * @returns {Promise<{reopened: object[], skipped: object[], minutes: number, dryRun: boolean,
 *   target: 'basket'|'pending'}>}
 */
export async function reopenExpiredRequests(connection, options = {}) {
  const ids = (options.ids || [])
    .map((id) => Math.trunc(Number(id)))
    .filter((id) => Number.isFinite(id) && id > 0);
  const email = String(options.requesterEmail || '')
    .trim()
    .toLowerCase();
  const accountName = String(options.accountName || '').trim();
  const itemText = String(options.itemText || '').trim();
  const limit = Math.max(0, Math.trunc(Number(options.limit) || 0));
  const minutes = holdMinutes(options.minutes);
  const dryRun = Boolean(options.dryRun);
  // Two destinations, one difference that matters to the owner: a basket row asks them for
  // nothing until it is sent, a pending one is waiting on them already.
  const target = options.target === 'pending' ? 'pending' : 'basket';

  const where = ["r.status = 'expired'"];
  const params = [];

  if (ids.length > 0) {
    where.push(`r.id IN (${inClause(ids)})`);
    params.push(...ids);
  }

  if (email) {
    where.push('u.email = ?');
    params.push(email);
  }

  if (accountName) {
    where.push('r.requester_account_name = ?');
    params.push(accountName);
  }

  if (itemText) {
    where.push('r.item_name LIKE ?');
    params.push(`%${itemText}%`);
  }

  // The item's current row is joined by the owner's account as well as the id: a row id
  // says nothing once that upload has been replaced, and re-opening against somebody
  // else's stack would hold a copy that was never offered to this person.
  const [rows] = await connection.execute(
    `SELECT r.id, r.requester_user_id, r.requester_account_name, r.owner_account_name,
            r.item_kind, r.shared_item_id, r.always_share_id, r.item_name,
            r.quantity, r.quantity_requested,
            i.id AS inventory_id, i.item_count AS inventory_count,
            a.id AS offer_id,
            replacement.id AS replacement_id,
            replacement.item_count AS replacement_count,
            u.email AS requester_email
       FROM itemshare_requests r
       LEFT JOIN itemshare_shared_items i
              ON i.id = r.shared_item_id AND i.account_name = r.owner_account_name
       LEFT JOIN itemshare_always_share a
              ON a.id = r.always_share_id AND a.account_name = r.owner_account_name
       -- The row the item lives under now, found the way reconcileRequestsForOwner finds
       -- it: the owner's newest row with the same item key. A standing offer keeps its id
       -- through the upsert that rewrites it, so only inventory rows can move.
       LEFT JOIN itemshare_shared_items replacement
              ON r.item_kind = 'inventory'
             AND replacement.id = (
                   SELECT MAX(newer.id)
                     FROM itemshare_shared_items newer
                    WHERE newer.account_name = r.owner_account_name
                      AND newer.item_key_hash = r.item_key_hash
                 )
       LEFT JOIN itemshare_users u ON u.id = r.requester_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.id ASC${limit > 0 ? `\n      LIMIT ${limit}` : ''}`,
    params
  );

  const reopened = [];
  const skipped = [];

  for (const row of rows) {
    const described = {
      id: Number(row.id),
      itemName: String(row.item_name || 'an item'),
      itemKind: row.item_kind === 'offer' ? 'offer' : 'inventory',
      requesterAccount: String(row.requester_account_name || ''),
      ownerAccount: String(row.owner_account_name || ''),
      email: String(row.requester_email || ''),
    };
    let targetId =
      described.itemKind === 'offer' ? Number(row.offer_id) : Number(row.inventory_id);
    let total = Number(row.inventory_count) || 0;
    const moved =
      described.itemKind === 'inventory' && !targetId && Number(row.replacement_id) > 0;

    // The owner is still sharing this item; only the row it was recorded under is gone.
    if (moved) {
      targetId = Number(row.replacement_id);
      total = Number(row.replacement_count) || 0;
    }

    if (!targetId) {
      skipped.push({
        ...described,
        reason:
          described.itemKind === 'offer'
            ? 'that standing offer is no longer shared'
            : 'that item is no longer shared by the owner',
      });
      continue;
    }

    const wanted = Math.max(1, Math.trunc(Number(row.quantity) || 1));
    let quantity = wanted;

    if (described.itemKind === 'offer') {
      // A standing offer is a promise rather than a count, so one copy at a time and only
      // while nobody else is holding it.
      if ((await reservedQuantity(connection, 'offer', targetId)) >= 1) {
        skipped.push({ ...described, reason: 'that offer has already been asked for' });
        continue;
      }

      quantity = 1;
    } else {
      const reserved = await reservedQuantity(connection, 'inventory', targetId);
      const delivered = await deliveredSinceUpload(connection, 'inventory', targetId);
      const room = requestRoom({ total, reserved, delivered });

      if (room <= 0) {
        skipped.push({
          ...described,
          reason:
            total <= 0
              ? 'the owner no longer has any of it on their list'
              : 'every copy is spoken for',
        });
        continue;
      }

      quantity = Math.min(wanted, room);
    }

    if (!dryRun) {
      // The pending branch says exactly what submitDrafts says, minus the email: the same
      // UTC stamp, and no expiry, because a request waiting on an owner does not lapse.
      await connection.execute(
        target === 'pending'
          ? `UPDATE itemshare_requests
                SET status = 'pending',
                    quantity = ?,
                    quantity_requested = ?,
                    submitted_at = UTC_TIMESTAMP(),
                    expires_at = NULL,
                    status_reason = '',
                    closed_at = NULL
              WHERE id = ? AND status = 'expired'`
          : `UPDATE itemshare_requests
                SET status = 'draft',
                    quantity = ?,
                    quantity_requested = ?,
                    expires_at = (NOW() + INTERVAL ${minutes} MINUTE),
                    status_reason = '',
                    closed_at = NULL,
                    submitted_at = NULL
              WHERE id = ? AND status = 'expired'`,
        [quantity, quantity, Number(row.id)]
      );

      // It is the same item, so the request is re-pointed at the row it lives under now:
      // the next run of this command, and the requester's own history, then agree with
      // the owner's list instead of holding a dead id for ever.
      if (moved) {
        await connection.execute(
          'UPDATE itemshare_requests SET shared_item_id = ? WHERE id = ?',
          [targetId, Number(row.id)]
        );
      }
    }

    reopened.push({
      ...described,
      quantity,
      asked: wanted,
      capped: quantity < wanted,
    });
  }

  return { reopened, skipped, minutes, dryRun, target };
}

async function reservedQuantity(connection, itemKind, targetId) {
  const column = itemKind === 'offer' ? 'always_share_id' : 'shared_item_id';
  const [[row]] = await connection.execute(
    `SELECT COALESCE(SUM(quantity), 0) AS reserved
       FROM itemshare_requests
      WHERE item_kind = ? AND ${holdingSql()} AND ${column} = ?`,
    [itemKind, targetId]
  );

  return Number(row?.reserved || 0);
}

/**
 * Settles every pending request against an owner's items once their file has been
 * written.
 *
 * Oldest first, because it was promised first: each request keeps its quantity
 * while the stack can still cover it. One whose item has gone - or whose turn the
 * stack no longer reaches - is cancelled with the sentence the requester needs to
 * read, rather than quietly disappearing from their list.
 *
 * A row id can change when an item moves to another character or is re-shared, so
 * matching on the item's key hash re-points the request instead of cancelling a
 * perfectly good one.
 *
 * @returns {Promise<number>} how many requests were cancelled
 */
export async function reconcileRequestsForOwner(connection, ownerAccountName) {
  const [rows] = await connection.execute(
    `SELECT r.id, r.item_kind, r.item_key_hash, r.shared_item_id, r.always_share_id,
            r.quantity, r.item_name,
            i.id AS inventory_id,
            i.item_count AS inventory_count,
            a.id AS offer_id,
            replacement.id AS replacement_id,
            replacement.item_count AS replacement_count
       FROM itemshare_requests r
       LEFT JOIN itemshare_shared_items i
              ON i.id = r.shared_item_id AND i.account_name = r.owner_account_name
       LEFT JOIN itemshare_always_share a
              ON a.id = r.always_share_id AND a.account_name = r.owner_account_name
       LEFT JOIN itemshare_shared_items replacement
              ON r.item_kind = 'inventory'
             AND replacement.id = (
                   SELECT MAX(newer.id)
                     FROM itemshare_shared_items newer
                    WHERE newer.account_name = r.owner_account_name
                      AND newer.item_key_hash = r.item_key_hash
                 )
      WHERE ${holdingSql('r')} AND r.owner_account_name = ?
      ORDER BY r.created_at ASC, r.id ASC`,
    [ownerAccountName]
  );

  const used = new Map();
  let cancelled = 0;

  for (const row of rows) {
    if (row.item_kind === 'offer') {
      if (!row.offer_id) {
        await cancelRequest(connection, row.id, `${ownerAccountName} withdrew that standing offer.`);
        cancelled += 1;
      }
      // A standing offer has no count to run out of, so nothing else closes it.
      continue;
    }

    let itemId = row.inventory_id ? Number(row.inventory_id) : null;
    let total = row.inventory_id ? Number(row.inventory_count) || 0 : 0;

    if (itemId === null && row.replacement_id) {
      itemId = Number(row.replacement_id);
      total = Number(row.replacement_count) || 0;
      await connection.execute('UPDATE itemshare_requests SET shared_item_id = ? WHERE id = ?', [
        itemId,
        row.id,
      ]);
    }

    if (itemId === null || total <= 0) {
      await cancelRequest(
        connection,
        row.id,
        `${ownerAccountName} is no longer sharing ${row.item_name || 'that item'}.`
      );
      cancelled += 1;
      continue;
    }

    const taken = used.get(itemId) || 0;

    if (taken + Number(row.quantity) > total) {
      await cancelRequest(
        connection,
        row.id,
        taken > 0
          ? `${ownerAccountName} has ${total} of ${row.item_name || 'that item'} and every one is already spoken for.`
          : `${ownerAccountName} now has ${total} of ${row.item_name || 'that item'}, which does not cover the ${row.quantity} you asked for.`
      );
      cancelled += 1;
      continue;
    }

    used.set(itemId, taken + Number(row.quantity));
  }

  return cancelled;
}

/**
 * The item a request is aimed at, as the requester is allowed to see it. Null when
 * it is not theirs to ask for: an invisible item must not be requestable any more
 * than it is listable.
 */
export async function getRequestTarget(
  connection,
  accountNames,
  itemKind,
  targetId,
  { restrictToGuilds = true } = {}
) {
  const names = viewerAccountNames(accountNames);
  const id = Number(targetId);

  if (names.length === 0 || !Number.isFinite(id) || id <= 0) {
    return null;
  }

  // Asking and listing share the same exact guild/platform/server scope.
  const restrict = restrictToGuilds;

  if (itemKind === 'offer') {
    const scope = alwaysShareScope(names, restrict);
    const [rows] = await connection.execute(
      `SELECT DISTINCT a.id, a.account_name, a.item_name, a.item_id, a.item_key_hash,
              a.icon_key, a.quality, a.item_type_name, a.trait, a.enchant_name,
              a.style_name, a.required_level, a.required_cp
         ${scope.from}
        WHERE ${scope.clause} AND a.id = ?
        LIMIT 1`,
      [...scope.params, id]
    );

    return rows[0] || null;
  }

  const scope = inventoryScope(names, restrict);
  const [rows] = await connection.execute(
    `SELECT DISTINCT i.id, i.account_name, i.item_name, i.item_id, i.item_key_hash,
            i.icon_key, i.quality, i.item_type_name, i.trait, i.enchant_name, i.item_count,
            i.style_name, i.required_level, i.required_cp, i.location_label
       ${scope.from}
      WHERE ${scope.clause} AND i.id = ?
      LIMIT 1`,
    [...scope.params, id]
  );

  return rows[0] || null;
}

/**
 * The requester's account that shares a guild with the owner: that is the character
 * the handover would actually happen on, so it is the one worth recording.
 */
async function closestRequesterAccount(connection, mine, ownerAccountName) {
  if (mine.length === 0) {
    return '';
  }

  const [rows] = await connection.execute(
    `SELECT viewer.account_name
       FROM itemshare_account_guilds viewer
       JOIN itemshare_account_guilds owner
         ON owner.guild_id = viewer.guild_id
        AND ${sameWorldSql('owner', 'viewer')}
      WHERE owner.account_name = ? AND viewer.account_name IN (${inClause(mine)})
      ORDER BY viewer.account_name ASC
      LIMIT 1`,
    [ownerAccountName, ...mine]
  );

  return rows[0] ? rows[0].account_name : '';
}

/**
 * Records that someone wants part of a stack.
 *
 * The quantity is checked against what is left after the requests already waiting,
 * not against the raw count, so two people cannot both be promised the same five.
 * A standing offer is a promise rather than a count, so it always means one.
 *
 * Asking again for a row already in the basket updates that draft instead of adding a
 * second one, so the quantity returned is the total the single row now holds.
 *
 * @returns {Promise<{id: number, quantity: number, itemName: string, ownerAccountName: string, combined?: boolean}>}
 */
export async function createRequest(
  connection,
  {
    userId,
    requesterAccounts,
    ownAccounts = requesterAccounts,
    requesterAccount = '',
    itemKind,
    itemId,
    quantity,
    holdMinutes: minutes,
    // A guest asked while looking at everything that is shared, so the guild rule that
    // narrows a known account's list must not narrow their request either.
    restrictToGuilds = true,
  }
) {
  const kind = itemKind === 'offer' ? 'offer' : 'inventory';
  // Visibility comes from the account being browsed as, so the Request list and this
  // endpoint agree about what can be asked for. "Is it already mine?" has to look at
  // every account the person owns, or a second account could ask itself for an item.
  const target = await getRequestTarget(connection, requesterAccounts, kind, itemId, {
    restrictToGuilds,
  });
  const mine = viewerAccountNames(ownAccounts);

  if (!target) {
    const error = new Error('That item is not shared with you, so there is nothing to request.');
    error.statusCode = 404;
    throw error;
  }

  if (mine.includes(String(target.account_name))) {
    const error = new Error('That item is already yours.');
    error.statusCode = 400;
    throw error;
  }

  let wanted = Math.max(1, Math.trunc(Number(quantity) || 1));
  let existingDraft = null;
  let room = wanted;

  if (kind === 'inventory') {
    const total = Number(target.item_count) || 0;
    const reserved = await reservedQuantity(connection, 'inventory', Number(target.id));
    // Copies already mailed and not yet left out of the uploaded count are gone as
    // surely as a hold is: offering them again would promise the same copy twice.
    const delivered = await deliveredSinceUpload(connection, 'inventory', Number(target.id));
    existingDraft = await ownDraftForTarget(connection, userId, 'inventory', Number(target.id));
    const alreadyHeld = existingDraft ? Number(existingDraft.quantity) || 0 : 0;
    room = requestRoom({ total, reserved, delivered, alreadyHeld });
    // What nobody has claimed yet. The basket is already inside `reserved`, so this is
    // the number the dialog measures against, and the most one request may add.
    const free = Math.max(0, room - alreadyHeld);

    if (free <= 0) {
      const error = new Error('Every copy of that item has already been asked for.');
      error.statusCode = 409;
      throw error;
    }

    if (wanted > free) {
      const error = new Error(
        alreadyHeld > 0
          ? `You already hold ${alreadyHeld}; ${free} more ${free === 1 ? 'is' : 'are'} all that is left of the ${total} shared.`
          : free === 1
            ? 'Only one is left to ask for.'
            : `Only ${free} are left to ask for${reserved > 0 ? ` (${reserved} of ${total} already requested)` : ''}.`
      );
      error.statusCode = 409;
      throw error;
    }
  } else {
    // A standing offer is a promise rather than a count, so it always means one, and one
    // copy at a time: a second request would be promising the same handover twice.
    wanted = 1;

    if ((await reservedQuantity(connection, 'offer', Number(target.id))) >= 1) {
      const error = new Error(
        'That offer has already been asked for, so there is nothing left to hand over yet.'
      );
      error.statusCode = 409;
      throw error;
    }
  }

  // Asking again for something already in the basket tops that row up by the number
  // just picked: one row per item, holding the sum, so asking for one twice leaves it
  // holding two rather than the same thing twice.
  if (existingDraft) {
    const combined = combineQuantity({
      wanted,
      alreadyHeld: Number(existingDraft.quantity) || 0,
      room,
    });

    await connection.execute(
      `UPDATE itemshare_requests
          SET quantity = ?, quantity_requested = ?
        WHERE id = ? AND requester_user_id = ? AND status = 'draft'`,
      [combined, combined, Number(existingDraft.id), Number(userId)]
    );
    await resetBasketClock(connection, userId, minutes);

    return {
      id: Number(existingDraft.id),
      quantity: combined,
      itemName: target.item_name || 'that item',
      ownerAccountName: target.account_name,
      combined: true,
      basket: await getDraftBasket(connection, userId, minutes),
    };
  }

  // The account being browsed as is the character the owner is told to mail, so it
  // wins whenever it is really theirs; the guild-sharing account is still the best
  // answer for anything that arrives without a choice.
  const fromAccount =
    (requesterAccount && mine.includes(requesterAccount) ? requesterAccount : '') ||
    (await closestRequesterAccount(connection, mine, target.account_name)) ||
    mine[0] ||
    '';

  const [inserted] = await connection.execute(
    `INSERT INTO itemshare_requests
       (requester_user_id, requester_account_name, owner_account_name, item_kind,
        shared_item_id, always_share_id, item_key_hash, item_name, icon_key, item_id, quality,
        item_type_name, trait, enchant_name, style_name, required_level, required_cp,
        location_label, quantity, quantity_requested,
        status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NOW() + INTERVAL ${holdMinutes(
       minutes
     )} MINUTE)`,
    [
      Number(userId),
      fromAccount,
      target.account_name,
      kind,
      kind === 'inventory' ? Number(target.id) : null,
      kind === 'offer' ? Number(target.id) : null,
      target.item_key_hash || '',
      target.item_name || '',
      target.icon_key || '',
      Number(target.item_id) || 0,
      Number(target.quality) || 0,
      target.item_type_name || '',
      target.trait || '',
      target.enchant_name || '',
      // The rest of what tells this copy from another of the same name: the owner
      // answering the ask reads these instead of the live row, which the next upload
      // may have pruned or rewritten.
      target.style_name || '',
      Number(target.required_level) || 0,
      Number(target.required_cp) || 0,
      // Where the copy sat when it was asked for, so the owner's email can name a
      // container instead of leaving them to search. Empty for a standing offer.
      target.location_label || '',
      wanted,
      // What was asked for, kept even after a partial handover rewrites `quantity`.
      wanted,
    ]
  );

  // The row was inserted as a draft and then every draft this person holds is
  // pushed to the same new deadline, so the clock on screen is one number.
  await resetBasketClock(connection, userId, minutes);

  return {
    id: Number(inserted.insertId),
    quantity: wanted,
    itemName: target.item_name || 'that item',
    ownerAccountName: target.account_name,
    // Which ESO account asked, so a log line can name the account rather than the
    // Discord handle behind it. This is the account being browsed as when there is one.
    requesterAccountName: fromAccount,
    basket: await getDraftBasket(connection, userId, minutes),
  };
}

/**
 * The history of what one person has asked for: newest first, oldest last.
 *
 * A request that was taken out of the basket before it was ever sent is not history
 * - it was never asked - so it is excluded here and shown in the basket instead.
 */
export async function getRequesterRequests(connection, userId, { page = 1, pageSize = 5 } = {}) {
  const size = Math.max(1, Math.min(100, Math.trunc(Number(pageSize)) || 5));
  const offset = (Math.max(1, Math.trunc(Number(page)) || 1) - 1) * size;
  const [rows] = await connection.execute(
    `SELECT r.id, r.item_kind, r.item_name, r.item_id, r.icon_key, r.quality,
            r.item_type_name, r.trait, r.owner_account_name, r.requester_account_name,
            r.quantity, r.quantity_requested, r.status, r.status_reason, r.created_at,
            r.closed_at, r.submitted_at,
            -- The moment it was sent, as UTC text, so no driver time zone can
            -- reinterpret it on the way to the browser.
            DATE_FORMAT(r.submitted_at, '%Y-%m-%dT%H:%i:%sZ') AS submitted_at_iso,
            (ic.icon_key IS NOT NULL) AS has_icon
       FROM itemshare_requests r
       LEFT JOIN itemshare_item_icons ic ON ic.icon_key = r.icon_key
      WHERE r.requester_user_id = ?
        -- What was actually asked for and still means something: waiting, handed
        -- over, or refused. A basket item that was removed or timed out was never
        -- asked for, and a request that lapsed or was cancelled is not something the
        -- person successfully requested, so neither belongs in this list.
        AND r.submitted_at IS NOT NULL
        AND r.status IN ('pending', 'fulfilled', 'declined', 'cancelled')
      ORDER BY COALESCE(r.closed_at, r.submitted_at, r.created_at) DESC, r.id DESC
      LIMIT ${size} OFFSET ${offset}`,
    [Number(userId)]
  );

  return rows;
}

/** Five sent requests per page, including pages beyond the old fifty-row limit. */
export async function getRequesterHistory(connection, userId, requestedPage = 1) {
  const [[count]] = await connection.execute(
    `SELECT COUNT(*) AS total FROM itemshare_requests
      WHERE requester_user_id = ? AND submitted_at IS NOT NULL
        AND status IN ('pending', 'fulfilled', 'declined', 'cancelled')`,
    [Number(userId)]
  );
  const total = Number(count?.total) || 0;
  const totalPages = Math.max(1, Math.ceil(total / 5));
  const page = Math.min(totalPages, Math.max(1, Math.trunc(Number(requestedPage)) || 1));
  return { total, totalPages, page, rows: await getRequesterRequests(connection, userId, { page, pageSize: 5 }) };
}

/** Keep cancelled unsent rows briefly visible without counting them as holds. */
export const BASKET_CANCEL_LINGER_SECONDS = 5;

/**
 * What is in the basket: everything held but unsent, plus anything removed from it
 * in the last half minute so the removal can be seen rather than the row just
 * vanishing. Oldest first, because items are added to a basket over time.
 */
export async function getBasketRows(connection, userId) {
  const [rows] = await connection.execute(
    `SELECT r.id, r.item_kind, r.item_name, r.item_id, r.icon_key, r.quality,
            r.item_type_name, r.trait, r.owner_account_name, r.quantity, r.status,
            r.status_reason, r.created_at,
            (ic.icon_key IS NOT NULL) AS has_icon
       FROM itemshare_requests r
       LEFT JOIN itemshare_item_icons ic ON ic.icon_key = r.icon_key
      WHERE r.requester_user_id = ?
        AND (r.status = 'draft'
             OR (r.status = 'cancelled' AND r.submitted_at IS NULL
                 AND r.closed_at > (NOW() - INTERVAL ${BASKET_CANCEL_LINGER_SECONDS} SECOND)))
      ORDER BY r.created_at ASC, r.id ASC`,
    [Number(userId)]
  );

  return rows;
}

/** Recheck active holds against the selected account; sent requests are history. */
export async function reconcileDraftBasket(connection, { userId, accountName }) {
  await connection.beginTransaction();
  try {
    // Account switches update this same row. Hold its lock until reconciliation ends,
    // so an older live read cannot act on a selection replaced by another request.
    const [users] = await connection.execute(
      'SELECT browsing_eso_account_name FROM itemshare_users WHERE id = ? FOR UPDATE',
      [Number(userId)]
    );
    const linked = await getViewerAccounts(connection, userId);
    const names = linked.map(row => row.eso_account_name);
    const saved = String(users[0]?.browsing_eso_account_name || '');
    const selected = names.includes(saved) ? saved : names[0] || '';
    if (!users[0] || selected !== accountName) {
      await connection.commit();
      return { cancelled: 0, stale: true };
    }
    const result = await reconcileActiveDrafts(connection, { userId, accountName });
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

async function reconcileActiveDrafts(connection, { userId, accountName }) {
  const [drafts] = await connection.execute(
    `SELECT id, item_kind, shared_item_id, always_share_id
       FROM itemshare_requests
      WHERE requester_user_id = ? AND status = 'draft' AND expires_at > NOW()`,
    [Number(userId)]
  );
  let cancelled = 0;
  for (const draft of drafts) {
    const target = accountName ? await getRequestTarget(
      connection, [accountName], draft.item_kind,
      draft.item_kind === 'offer' ? draft.always_share_id : draft.shared_item_id
    ) : null;
    if (!target) {
      const [result] = await connection.execute(
        `UPDATE itemshare_requests
            SET status = 'cancelled', status_reason = ?, expires_at = NULL,
                closed_at = CURRENT_TIMESTAMP
          WHERE id = ? AND requester_user_id = ? AND status = 'draft'`,
        ['This item is not shared with the selected account on its platform and server.', Number(draft.id), Number(userId)]
      );
      cancelled += Number(result.affectedRows) || 0;
    } else {
      await connection.execute(
        `UPDATE itemshare_requests SET requester_account_name = ?
          WHERE id = ? AND requester_user_id = ? AND status = 'draft'
            AND requester_account_name <> ?`,
        [accountName, Number(draft.id), Number(userId), accountName]
      );
    }
  }
  return { cancelled };
}

/**
 * Takes back a request that has not been handed over yet, or one that has not even
 * been sent.
 *
 * A draft is removed rather than cancelled - the difference matters in the wording
 * the requester reads - and removing it counts as activity, so the rest of the
 * basket gets its full time back.
 */
export async function cancelOwnRequest(
  connection,
  { userId, requestId, holdMinutes: minutes }
) {
  const [rows] = await connection.execute(
    `SELECT id, status, item_name, owner_account_name, requester_account_name
       FROM itemshare_requests
      WHERE id = ? AND requester_user_id = ?
      LIMIT 1`,
    [Number(requestId), Number(userId)]
  );

  const row = rows[0];

  if (!row) {
    return {
      cancelled: false,
      wasDraft: false,
      itemName: '',
      ownerAccountName: '',
      requesterAccountName: '',
      basket: await getDraftBasket(connection, userId, minutes),
    };
  }

  // A request that has been sent belongs to the record now. The owner may already
  // have read it and put a copy aside, so taking it back is not the requester's
  // decision any more; the row stays in their history with whatever became of it.
  if (row.status !== 'draft') {
    return {
      cancelled: false,
      sentAlready: true,
      wasDraft: false,
      itemName: row.item_name || '',
      ownerAccountName: row.owner_account_name || '',
      requesterAccountName: row.requester_account_name || '',
      basket: await getDraftBasket(connection, userId, minutes),
    };
  }

  await connection.execute(
    `UPDATE itemshare_requests
        SET status = 'cancelled',
            status_reason = ?,
            expires_at = NULL,
            closed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND requester_user_id = ? AND status = 'draft'`,
    ['You removed it before sending.', Number(requestId), Number(userId)]
  );

  await resetBasketClock(connection, userId, minutes);

  return {
    cancelled: true,
    // Reaching here means the row was a draft, which is why it is removed rather than
    // cancelled; the requester is told so in those words.
    wasDraft: true,
    itemName: row.item_name || '',
    ownerAccountName: row.owner_account_name || '',
    requesterAccountName: row.requester_account_name || '',
    basket: await getDraftBasket(connection, userId, minutes),
  };
}

/**
 * Copies of one row that were mailed after the owner's current upload, so the stored
 * count still includes them. Only inventory rows carry a count; a standing offer is a
 * promise rather than a stack.
 */
async function deliveredSinceUpload(connection, itemKind, targetId) {
  if (itemKind !== 'inventory') {
    return 0;
  }

  const [[row]] = await connection.execute(
    `SELECT COALESCE(SUM(r.quantity), 0) AS delivered
       FROM itemshare_requests r
       JOIN itemshare_shared_items i ON i.id = r.shared_item_id
       LEFT JOIN itemshare_uploads up ON up.id = i.upload_id
      WHERE r.item_kind = 'inventory' AND r.status = 'fulfilled'
        AND (up.uploaded_at IS NULL OR r.fulfilled_at > up.uploaded_at)
        AND r.shared_item_id = ?`,
    [Number(targetId)]
  );

  return Number(row?.delivered || 0);
}

// --------------------------------------------------------- the owner's answer
// The email carries one form for every row in it, and the token in that form is the
// only credential: nobody signs in from a mail client. The token is stored as a hash,
// so a database dump cannot be used to answer somebody else's request; it expires, and
// answering clears it. That is what makes a double submit, a resent message or a link
// a mail client prefetched a no-op instead of a second delivery.

/** How long the form in a request email keeps working. */
export const EMAIL_TOKEN_DAYS = 30;

function hashEmailToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function looksLikeEmailToken(token) {
  return /^[a-f0-9]{64}$/.test(String(token || ''));
}

/**
 * Gives one email's requests a single token, replacing any earlier one.
 *
 * @returns {Promise<string|null>} the token for the address, or null when none of
 *   those rows is still waiting
 */
export async function issueRequestEmailToken(connection, requestIds) {
  const ids = (requestIds || []).map(Number).filter((id) => Number.isFinite(id) && id > 0);

  if (ids.length === 0) {
    return null;
  }

  const token = randomBytes(32).toString('hex');

  const [result] = await connection.execute(
    `UPDATE itemshare_requests
        SET email_token_hash = ?,
            email_token_expires_at = (NOW() + INTERVAL ${EMAIL_TOKEN_DAYS} DAY)
      WHERE id IN (${inClause(ids)}) AND status = 'pending'`,
    [hashEmailToken(token), ...ids]
  );

  return Number(result.affectedRows || 0) > 0 ? token : null;
}

/**
 * The form an email links to: every row of that message still waiting for an answer.
 * Null means the link is wrong, expired or already answered - one answer to the person
 * holding it.
 */
export async function getFulfillForm(connection, token) {
  if (!looksLikeEmailToken(token)) {
    return null;
  }

  const [rows] = await connection.execute(
    `SELECT id, item_kind, item_name, item_id, icon_key, quality, item_type_name,
            trait, enchant_name, owner_account_name, requester_account_name,
            quantity, quantity_requested
       FROM itemshare_requests
      WHERE email_token_hash = ? AND email_token_expires_at > NOW() AND status = 'pending'
      ORDER BY owner_account_name ASC, item_name ASC, id ASC`,
    [hashEmailToken(token)]
  );

  if (rows.length === 0) {
    return null;
  }

  return {
    token: String(token),
    rows: rows.map((row) => ({
      ...row,
      // A row written before migration 019, or by a script that predates it, still has
      // its ask in `quantity`; the form must never show an empty box.
      asked: Math.max(1, Number(row.quantity_requested) || Number(row.quantity) || 1),
    })),
  };
}

/** The answer form's numbers keyed by request id, however they arrived. */
function normalizeSent(sentById) {
  return sentById instanceof Map
    ? sentById
    : new Map(Object.entries(sentById || {}).map(([key, value]) => [Number(key), value]));
}

/**
 * Applies one answer form to the rows it is allowed to answer.
 *
 * Both ways in - the link in the email and the signed-in page - end here, so "0
 * cancels, anything else is handed over, never more than was asked for" exists once.
 * The caller has already selected and locked those rows, and commits afterwards.
 *
 * @returns {Promise<{rows: object[], cancelled: number, fulfilled: number, copies: number}>}
 */
async function applyAnswers(connection, rows, wanted) {
  const answered = [];
  let cancelled = 0;
  let fulfilled = 0;
  let copies = 0;

  for (const row of rows) {
    const id = Number(row.id);
    const raw = wanted.get(id);

    // A row this form did not carry is not answered: it keeps waiting rather than
    // being guessed at.
    if (raw === undefined || raw === null || raw === '') {
      continue;
    }

    const asked = Math.max(1, Number(row.quantity_requested) || Number(row.quantity) || 1);
    // Whole copies, never more than were asked for: a field edited on the way, or typed
    // as 999, must not invent stock nobody requested.
    const sent = Math.min(Math.max(0, Math.trunc(Number(raw) || 0)), asked);

    if (sent === 0) {
      await connection.execute(
        `UPDATE itemshare_requests
            SET status = 'cancelled',
                status_reason = ?,
                quantity = ?,
                quantity_requested = ?,
                closed_at = CURRENT_TIMESTAMP,
                email_token_hash = '',
                email_token_expires_at = NULL
          WHERE id = ? AND status = 'pending'`,
        [
          `${row.owner_account_name} had nothing to send, so the request was cancelled.`,
          asked,
          asked,
          id,
        ]
      );
      cancelled += 1;
      answered.push({
        id,
        itemName: row.item_name || '',
        // Named here rather than looked up afterwards: the row is closed by the time
        // anybody reads a confirmation, and who asked is half of what it says.
        requesterAccount: row.requester_account_name || '',
        asked,
        sent: 0,
        status: 'cancelled',
      });
      continue;
    }

    await connection.execute(
      `UPDATE itemshare_requests
          SET status = 'fulfilled',
              quantity = ?,
              quantity_requested = ?,
              status_reason = ?,
              fulfilled_at = CURRENT_TIMESTAMP,
              closed_at = CURRENT_TIMESTAMP,
              email_token_hash = '',
              email_token_expires_at = NULL
        WHERE id = ? AND status = 'pending'`,
      [sent, asked, sent < asked ? `${sent} of ${asked} sent` : '', id]
    );

    fulfilled += 1;
    copies += sent;
    answered.push({
      id,
      itemName: row.item_name || '',
      requesterAccount: row.requester_account_name || '',
      asked,
      sent,
      status: 'fulfilled',
    });
  }

  return { rows: answered, cancelled, fulfilled, copies };
}

/**
 * Joins the pending asks for one item into a single row.
 *
 * Asking twice for the same thing is one conversation, not two: two, then two more, then
 * one is a row that says five and is answered with one number. The grouped row keeps
 * every member id, so a partial answer still lands on the oldest asks first and whatever
 * the number does not reach stays pending. `id` is the oldest member, which is what the
 * page's form names when it answers.
 *
 * Rows with no usable item id are kept on their own: two items both numbered 0 are not
 * necessarily the same item, and merging them would answer one with the other.
 */
function groupPendingAsks(rows) {
  const groups = new Map();

  for (const row of rows) {
    const itemId = Number(row.item_id) || 0;
    const asked = Math.max(1, Number(row.quantity_requested) || Number(row.quantity) || 1);
    const key =
      itemId > 0
        ? [
            row.item_kind,
            itemId,
            row.owner_account_name,
            row.trait || '',
            row.enchant_name || '',
            // Style, level and CP tell two copies apart as surely as the trait does:
            // merging a level 10 and a level 50 dagger into one number would answer the
            // wrong one.
            row.style_name || '',
            Number(row.required_level) || 0,
            Number(row.required_cp) || 0,
          ].join('|')
        : `row|${Number(row.id)}`;
    const requester = String(row.requester_account_name || '');
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        key,
        id: Number(row.id),
        ids: [Number(row.id)],
        item_kind: row.item_kind,
        item_name: row.item_name,
        item_id: itemId,
        icon_key: row.icon_key,
        quality: row.quality,
        item_type_name: row.item_type_name,
        trait: row.trait,
        enchant_name: row.enchant_name,
        style_name: row.style_name || '',
        required_level: Number(row.required_level) || 0,
        required_cp: Number(row.required_cp) || 0,
        // Where the copy was sitting when it was asked for - the same fact the request
        // email prints, so the site can name the container without opening the message.
        location_label: row.location_label || '',
        owner_account_name: row.owner_account_name,
        requesters: requester ? [requester] : [],
        asked,
        requests: 1,
        first_submitted_at: row.submitted_at,
        last_submitted_at: row.submitted_at,
      });
      continue;
    }

    existing.ids.push(Number(row.id));
    existing.asked += asked;
    existing.requests += 1;
    existing.last_submitted_at = row.submitted_at;

    // Rows for one item can differ if it was moved between asks; any of them names a
    // container better than an empty cell, so the first one seen fills it.
    if (!existing.location_label && row.location_label) {
      existing.location_label = row.location_label;
    }

    if (requester && !existing.requesters.includes(requester)) {
      existing.requesters.push(requester);
    }
  }

  return [...groups.values()];
}

/**
 * What is waiting on this person's own items, oldest ask first because that is the one
 * that was promised first, and one row per item however many asks stand behind it. The
 * email form and this list answer the same rows; this is the copy that does not need a
 * message to exist.
 */
export async function getOwnerRequests(connection, accountNames, { limit = 200 } = {}) {
  const names = viewerAccountNames(accountNames);

  if (names.length === 0) {
    return [];
  }

  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));

  const [rows] = await connection.execute(
    `SELECT r.id, r.item_kind, r.item_name, r.item_id, r.icon_key, r.quality,
            r.item_type_name, r.trait, r.enchant_name, r.style_name,
            r.required_level, r.required_cp, r.location_label,
            r.owner_account_name, r.requester_account_name, r.quantity, r.quantity_requested,
            r.submitted_at
       FROM itemshare_requests r
      WHERE r.status = 'pending' AND r.owner_account_name IN (${inClause(names)})
      ORDER BY COALESCE(r.submitted_at, r.created_at) ASC, r.id ASC
      LIMIT ${safeLimit}`,
    names
  );

  return groupPendingAsks(rows);
}

/**
 * The same answer, given on the site by the signed-in owner.
 *
 * Only rows belonging to accounts linked to this person are selected, so a form that
 * named somebody else's request finds nothing to change.
 */
export async function recordOwnerAnswer(connection, { accountNames, sentById }) {
  const names = viewerAccountNames(accountNames);
  const empty = { rows: [], cancelled: 0, fulfilled: 0, copies: 0 };

  if (names.length === 0) {
    return empty;
  }

  await connection.beginTransaction();

  try {
    const [rows] = await connection.execute(
      `SELECT id, item_kind, item_name, owner_account_name, requester_account_name,
              quantity, quantity_requested
         FROM itemshare_requests
        WHERE status = 'pending' AND owner_account_name IN (${inClause(names)})
        FOR UPDATE`,
      names
    );

    if (rows.length === 0) {
      await connection.rollback();
      return empty;
    }

    const summary = await applyAnswers(connection, rows, normalizeSent(sentById));

    await connection.commit();
    return summary;
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

/**
 * One answer for one item, however many separate asks it stands for.
 *
 * The number the owner typed is how many copies left their bag. It is spent on the oldest
 * rows first - the ones that were promised first - and a row it does not reach keeps
 * waiting, so one number closes the requests it belongs to without inventing an answer
 * for the rest. A 0 is the Not fulfilled button: nothing was sent, so every ask for that
 * item is cancelled with the owner's reason on it.
 */
export async function recordOwnerGroupAnswer(connection, { accountNames, anchorId, sent }) {
  const names = viewerAccountNames(accountNames);
  const id = Number(anchorId);
  const empty = { rows: [], cancelled: 0, fulfilled: 0, copies: 0 };

  if (names.length === 0 || !Number.isInteger(id) || id <= 0) {
    return empty;
  }

  await connection.beginTransaction();

  try {
    const [anchorRows] = await connection.execute(
      `SELECT id, item_kind, item_id, item_name, owner_account_name, requester_account_name,
              quantity, quantity_requested, trait, enchant_name
         FROM itemshare_requests
        WHERE owner_account_name IN (${inClause(names)})
          AND id = ? AND status = 'pending'
        LIMIT 1
        FOR UPDATE`,
      [...names, id]
    );
    const anchor = anchorRows[0];

    if (!anchor) {
      await connection.rollback();
      return empty;
    }

    const itemId = Number(anchor.item_id) || 0;
    let members;

    if (itemId > 0) {
      const [grouped] = await connection.execute(
        `SELECT id, item_kind, item_name, owner_account_name, requester_account_name,
                quantity, quantity_requested
           FROM itemshare_requests
          WHERE owner_account_name IN (${inClause(names)})
            AND status = 'pending' AND item_kind = ? AND item_id = ?
            AND trait = ? AND enchant_name = ?
          ORDER BY COALESCE(submitted_at, created_at) ASC, id ASC
          FOR UPDATE`,
        [
          ...names,
          anchor.item_kind,
          itemId,
          String(anchor.trait || ''),
          String(anchor.enchant_name || ''),
        ]
      );
      members = grouped;
    } else {
      members = [anchor];
    }

    const whole = Math.max(0, Math.trunc(Number(sent) || 0));
    const answers = new Map();

    if (whole === 0) {
      for (const row of members) {
        answers.set(Number(row.id), 0);
      }
    } else {
      let left = whole;

      for (const row of members) {
        if (left <= 0) {
          break;
        }

        const asked = Math.max(1, Number(row.quantity_requested) || Number(row.quantity) || 1);
        const give = Math.min(left, asked);
        answers.set(Number(row.id), give);
        left -= give;
      }
    }

    const summary = await applyAnswers(connection, members, answers);

    await connection.commit();
    return summary;
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

/**
 * Records what the owner says they sent, one number per row: 0 cancels that row,
 * anything else hands that many copies over.
 *
 * The handover becomes the row's `quantity` - nothing is outstanding any more - while
 * `quantity_requested` keeps the ask, so the requester can still read "4 of 10". The
 * rows are locked and the token cleared in the same transaction, so two submits of one
 * form cannot both apply.
 *
 * @param {Map<number, number>|object} sentById copies actually sent, keyed by request id
 * @returns {Promise<null|{rows: object[], cancelled: number, fulfilled: number, copies: number}>}
 */
export async function recordFulfillment(connection, { token, sentById }) {
  if (!looksLikeEmailToken(token)) {
    return null;
  }

  const wanted = normalizeSent(sentById);

  await connection.beginTransaction();

  try {
    const [rows] = await connection.execute(
      `SELECT id, item_kind, item_name, owner_account_name, quantity, quantity_requested
         FROM itemshare_requests
        WHERE email_token_hash = ? AND email_token_expires_at > NOW() AND status = 'pending'
        FOR UPDATE`,
      [hashEmailToken(token)]
    );

    if (rows.length === 0) {
      await connection.rollback();
      return null;
    }

    const summary = await applyAnswers(connection, rows, wanted);

    await connection.commit();
    return summary;
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}
