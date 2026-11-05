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

async function upsertGuilds(connection, guilds) {
  for (const [guildId, guildName] of guilds) {
    await connection.execute(
      `INSERT INTO itemshare_guilds (guild_id, guild_name) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE guild_name = IF(VALUES(guild_name) = '', guild_name, VALUES(guild_name))`,
      [guildId, guildName]
    );
  }
}

async function replaceAccountGuilds(connection, accountName, guilds) {
  await connection.execute('DELETE FROM itemshare_account_guilds WHERE account_name = ?', [accountName]);

  for (const guildId of guilds.keys()) {
    await connection.execute(
      'INSERT IGNORE INTO itemshare_account_guilds (account_name, guild_id) VALUES (?, ?)',
      [accountName, guildId]
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

async function replaceOneAccount(
  connection,
  { accountName, items, alwaysShare = [], guilds, sourceFile, addonVersion = '', userId }
) {
  const totalQuantity = items.reduce((sum, item) => sum + (item.itemCount || 0), 0);

  await upsertGuilds(connection, guilds);
  await replaceAccountGuilds(connection, accountName, guilds);

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

  // Write first, prune second. Everything the file mentions is refreshed where it
  // already stands - same row, same id, same first_seen_at - so an item never
  // blinks out of the list and anything pointing at the row keeps pointing at it.
  for (const item of items) {
    const [written] = await connection.execute(ITEM_UPSERT_SQL, itemValues(item, uploadId));
    const itemId = written.insertId;

    // The guilds an item is offered to can change between uploads, so the links
    // are rewritten per item rather than left to accumulate.
    await connection.execute('DELETE FROM itemshare_shared_item_guilds WHERE item_id = ?', [itemId]);

    for (const guildId of item.guildIds) {
      await connection.execute(
        'INSERT IGNORE INTO itemshare_shared_item_guilds (item_id, guild_id) VALUES (?, ?)',
        [itemId, guildId]
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
        'INSERT IGNORE INTO itemshare_always_share_guilds (always_share_id, guild_id) VALUES (?, ?)',
        [offerId, guildId]
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
    itemCount: items.length,
    totalQuantity,
    guildCount: guilds.size,
    alwaysShareCount: alwaysShare.length,
    removedItems: Number(removedItems.affectedRows || 0),
    removedOffers: Number(removedOffers.affectedRows || 0),
    cancelledRequests,
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
            requester_account_name, item_type_name, trait, enchant_name, quality
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

  return {
    itemCount: Number(items?.itemCount || 0),
    totalQuantity: Number(items?.totalQuantity || 0),
    guildCount: Number(guilds?.guildCount || 0),
    lastUpload: lastUpload || null,
    link: linked[0] || null,
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

function viewerAccountNames(accountNames) {
  return [...new Set((accountNames || []).map((name) => String(name || '').trim()).filter(Boolean))];
}

import { filterList } from './filters.js';

function inClause(values) {
  return values.map(() => '?').join(', ');
}

/** Guilds any of the viewer's ESO accounts belongs to. */
export async function getViewerGuilds(connection, accountNames) {
  const names = viewerAccountNames(accountNames);
  if (names.length === 0) {
    return [];
  }

  const [rows] = await connection.execute(
    `SELECT ag.guild_id, COALESCE(g.guild_name, '') AS guild_name
       FROM itemshare_account_guilds ag
       LEFT JOIN itemshare_guilds g ON g.guild_id = ag.guild_id
      WHERE ag.account_name IN (${inClause(names)})
      GROUP BY ag.guild_id, g.guild_name
      ORDER BY guild_name ASC, ag.guild_id ASC`,
    names
  );
  return rows;
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
       LEFT JOIN itemshare_guilds g ON g.guild_id = ig.guild_id
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
       LEFT JOIN itemshare_guilds g ON g.guild_id = ag.guild_id
       LEFT JOIN itemshare_item_icons icon ON icon.icon_key = a.icon_key`;
}

function alwaysShareVisibilityClause(names) {
  return `(viewer.account_name IS NOT NULL
           OR (ag.guild_id IS NULL AND a.account_name IN (${inClause(names)})))`;
}

/**
 * Item types and owner accounts present in what the viewer can see, used to fill
 * the filter controls. Not affected by the active filters.
 */
export async function getViewerFacets(connection, accountNames) {
  const names = viewerAccountNames(accountNames);
  if (names.length === 0) {
    return { types: [], owners: [] };
  }

  // The facets have to follow the same visibility rule as the grid, or a type
  // that only appears on an unattributed entry cannot be filtered to.
  const [types] = await connection.execute(
    `SELECT i.item_type_name AS name, COUNT(DISTINCT i.id) AS total
     ${visibleItemsFrom(names)}
      WHERE i.item_type_name <> '' AND ${itemsVisibilityClause(names)}
      GROUP BY i.item_type_name
      ORDER BY i.item_type_name ASC`,
    [...names, ...names]
  );

  const [owners] = await connection.execute(
    `SELECT DISTINCT i.account_name AS name
     ${visibleItemsFrom(names)}
      WHERE ${itemsVisibilityClause(names)}
      ORDER BY i.account_name ASC`,
    [...names, ...names]
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

  for (const row of rows) {
    const count = byId.get(Number(row.id));
    row.reserved = Number(count?.reserved || 0);
    row.request_count = Number(count?.request_count || 0);
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
 */
async function attachViewerDrafts(connection, rows, viewerNames) {
  for (const row of rows || []) {
    row.my_draft_quantity = 0;
  }

  const names = (viewerNames || []).filter(Boolean);
  const ids = (rows || []).map((row) => Number(row.id)).filter(Number.isFinite);

  if (names.length === 0 || ids.length === 0) {
    return rows;
  }

  const [drafts] = await connection.execute(
    `SELECT shared_item_id AS target_id, COALESCE(SUM(quantity), 0) AS held
       FROM itemshare_requests
      WHERE item_kind = 'inventory' AND status = 'draft' AND expires_at > NOW()
        AND requester_account_name IN (${inClause(names)})
        AND shared_item_id IN (${inClause(ids)})
      GROUP BY shared_item_id`,
    [...names, ...ids]
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
  { type = '', owner = '', search = '', added = '', sort = '', dir = '', limit = 500 } = {}
) {
  const names = viewerAccountNames(accountNames);
  if (names.length === 0) {
    return [];
  }

  const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 500));
  const filters = [itemsVisibilityClause(names)];
  const params = [...names, ...names];

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
            i.account_name,
            i.character_name,
            (icon.icon_key IS NOT NULL) AS has_icon,
            GROUP_CONCAT(DISTINCT g.guild_name ORDER BY g.guild_name SEPARATOR ', ') AS guild_names
       ${visibleItemsFrom(names)}
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
  return attachViewerDrafts(connection, counted, names);
}

/**
 * Standing offers visible to the viewer: joined through the guilds the item is
 * offered to, exactly like the inventory list. `in_inventory` says whether an
 * owned copy exists right now, which is the one thing the offer itself cannot
 * know — the owner may have none at all.
 */
export async function getAlwaysShareForViewer(
  connection,
  accountNames,
  { type = '', owner = '', search = '', added = '', sort = '', dir = '', limit = 500 } = {}
) {
  const names = viewerAccountNames(accountNames);
  if (names.length === 0) {
    return [];
  }

  const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 500));
  const filters = [alwaysShareVisibilityClause(names)];
  const params = [...names, ...names];

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
            a.account_name,
            a.character_name,
            (icon.icon_key IS NOT NULL) AS has_icon,
            (SELECT COUNT(*)
               FROM itemshare_shared_items own
              WHERE own.account_name = a.account_name
                AND a.item_id > 0
                AND own.item_id = a.item_id) > 0 AS in_inventory,
            GROUP_CONCAT(DISTINCT g.guild_name ORDER BY g.guild_name SEPARATOR ', ') AS guild_names
       ${visibleAlwaysShareFrom(names)}
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
 * Links an ESO account to the signed-in person.
 * @returns {Promise<'linked'|'already-linked'|'conflict'>}
 */
export async function linkAccountToUser(connection, { accountName, userId }) {
  const [rows] = await connection.execute(
    'SELECT user_id FROM itemshare_accounts WHERE eso_account_name = ?',
    [accountName]
  );

  const existing = rows[0];

  if (existing && existing.user_id && Number(existing.user_id) !== Number(userId)) {
    return 'conflict';
  }

  if (existing) {
    await connection.execute(
      'UPDATE itemshare_accounts SET user_id = ? WHERE eso_account_name = ?',
      [userId, accountName]
    );
    return 'already-linked';
  }

  await connection.execute(
    'INSERT INTO itemshare_accounts (eso_account_name, user_id) VALUES (?, ?)',
    [accountName, userId]
  );
  return 'linked';
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
export async function getDraftBasket(connection, userId) {
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
    holdMinutes: DEFAULT_HOLD_MINUTES,
  };
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
            status_reason = 'The request was not sent within the time allowed, so the items went back to being available.',
            closed_at = CURRENT_TIMESTAMP
      WHERE status = 'draft' AND expires_at <= NOW()`
  );

  return Number(result.affectedRows || 0);
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
export async function getRequestTarget(connection, accountNames, itemKind, targetId) {
  const names = viewerAccountNames(accountNames);
  const id = Number(targetId);

  if (names.length === 0 || !Number.isFinite(id) || id <= 0) {
    return null;
  }

  if (itemKind === 'offer') {
    const [rows] = await connection.execute(
      `SELECT DISTINCT a.id, a.account_name, a.item_name, a.item_id, a.item_key_hash,
              a.icon_key, a.quality, a.item_type_name, a.trait, a.enchant_name,
              -- A standing offer is a promise, not a copy. There is nothing to hand
              -- over unless the owner has one in a bag at this moment, so the count
              -- is computed here rather than assumed from the offer existing.
              (SELECT COUNT(*)
                 FROM itemshare_shared_items own
                WHERE own.account_name = a.account_name
                  AND a.item_id > 0
                  AND own.item_id = a.item_id
                  AND own.item_count > 0) AS has_copy
         ${visibleAlwaysShareFrom(names)}
        WHERE ${alwaysShareVisibilityClause(names)} AND a.id = ?
        LIMIT 1`,
      [...names, ...names, id]
    );

    return rows[0] || null;
  }

  const [rows] = await connection.execute(
    `SELECT DISTINCT i.id, i.account_name, i.item_name, i.item_id, i.item_key_hash,
            i.icon_key, i.quality, i.item_type_name, i.trait, i.enchant_name, i.item_count
       ${visibleItemsFrom(names)}
      WHERE ${itemsVisibilityClause(names)} AND i.id = ?
      LIMIT 1`,
    [...names, ...names, id]
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
       JOIN itemshare_account_guilds owner ON owner.guild_id = viewer.guild_id
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
  }
) {
  const kind = itemKind === 'offer' ? 'offer' : 'inventory';
  // Visibility comes from the account being browsed as, so the Request list and this
  // endpoint agree about what can be asked for. "Is it already mine?" has to look at
  // every account the person owns, or a second account could ask itself for an item.
  const target = await getRequestTarget(connection, requesterAccounts, kind, itemId);
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
    wanted = 1;

    // Asking from a standing offer only makes sense while the owner actually has
    // one. The list hides the button in that case; this is the rule underneath it.
    if (!Number(target.has_copy)) {
      const error = new Error(
        'Nobody has a copy of that in a bag right now, so there is nothing to hand over yet.'
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
      basket: await getDraftBasket(connection, userId),
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
        item_type_name, trait, enchant_name, quantity, quantity_requested, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NOW() + INTERVAL ${holdMinutes(
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
  };
}

/**
 * The history of what one person has asked for: newest first, oldest last.
 *
 * A request that was taken out of the basket before it was ever sent is not history
 * - it was never asked - so it is excluded here and shown in the basket instead.
 */
export async function getRequesterRequests(connection, userId) {
  const [rows] = await connection.execute(
    `SELECT r.id, r.item_kind, r.item_name, r.item_id, r.icon_key, r.quality,
            r.item_type_name, r.trait, r.owner_account_name, r.requester_account_name,
            r.quantity, r.status, r.status_reason, r.created_at, r.closed_at, r.submitted_at,
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
      ORDER BY COALESCE(r.submitted_at, r.created_at) DESC, r.id DESC
      LIMIT 50`,
    [Number(userId)]
  );

  return rows;
}

/**
 * How long a removed basket item stays on screen saying so. The page fades it over
 * the same window, and the server stops returning it just after, so a refresh does
 * not bring it back.
 */
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
      basket: await getDraftBasket(connection, userId),
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
      basket: await getDraftBasket(connection, userId),
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
    basket: await getDraftBasket(connection, userId),
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
      answered.push({ id, itemName: row.item_name || '', asked, sent: 0, status: 'cancelled' });
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
    answered.push({ id, itemName: row.item_name || '', asked, sent, status: 'fulfilled' });
  }

  return { rows: answered, cancelled, fulfilled, copies };
}

/**
 * What is waiting on this person's own items, oldest ask first because that is the one
 * that was promised first. The email form and this list answer the same rows; this is
 * the copy that does not need a message to exist.
 */
export async function getOwnerRequests(connection, accountNames, { limit = 200 } = {}) {
  const names = viewerAccountNames(accountNames);

  if (names.length === 0) {
    return [];
  }

  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));

  const [rows] = await connection.execute(
    `SELECT r.id, r.item_kind, r.item_name, r.item_id, r.icon_key, r.quality,
            r.item_type_name, r.trait, r.enchant_name, r.owner_account_name,
            r.requester_account_name, r.quantity, r.quantity_requested, r.submitted_at
       FROM itemshare_requests r
      WHERE r.status = 'pending' AND r.owner_account_name IN (${inClause(names)})
      ORDER BY COALESCE(r.submitted_at, r.created_at) ASC, r.id ASC
      LIMIT ${safeLimit}`,
    names
  );

  return rows.map((row) => ({
    ...row,
    asked: Math.max(1, Number(row.quantity_requested) || Number(row.quantity) || 1),
  }));
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
      `SELECT id, item_kind, item_name, owner_account_name, quantity, quantity_requested
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
