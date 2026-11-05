// Item icons: fetched once from UESP's PNG mirror, then stored in MariaDB.
//
// The addon records the game's icon path, which is a DDS texture browsers cannot
// draw. UESP mirrors the same tree as PNG, so /esoui/art/icons/x.dds becomes
// https://esoicons.uesp.net/esoui/art/icons/x.png. Each distinct path is fetched
// at most once: afterwards the site serves the stored bytes from /icons/<key>.png
// and never contacts UESP again.

import { createHash } from 'node:crypto';

const ICON_BASE = 'https://esoicons.uesp.net';
const MAX_ICON_BYTES = 512 * 1024;

/**
 * The game path for an icon, with the leading slash the mirror needs.
 *
 * Some client getters answer without it (`esoui/art/icons/x.dds`), and that used to
 * be dropped by every step below, which left the item permanently blank even though
 * the path was correct. Repairing it once here keeps the key and the URL agreeing.
 */
export function gameIconPath(value) {
  const path = String(value || '').trim();
  if (!path) {
    return '';
  }
  return path.startsWith('/') ? path : `/${path}`;
}

/** Stable cache key for an icon path. */
export function iconCacheKey(iconPath) {
  const path = gameIconPath(iconPath);
  return path ? createHash('sha1').update(path, 'utf8').digest('hex') : '';
}

/** UESP PNG URL for a game icon path, or '' when the path is unusable. */
export function iconSourceUrl(iconPath) {
  const path = gameIconPath(iconPath);
  if (!path) {
    return '';
  }
  return `${ICON_BASE}${path.replace(/\.dds$/i, '.png')}`;
}

/**
 * Fetches and stores only the icons that are not in the database yet.
 *
 * UESP is a last resort, not a per-upload step: the cache table is checked first
 * (in chunks), and every path already present costs nothing but one row in that
 * lookup. Best effort: a failure leaves the icon missing and is retried by a
 * later upload, never by page views.
 *
 * @returns {Promise<{fetched: number, skipped: number, failed: number}>}
 */
export async function cacheItemIcons(connection, iconPaths, { limit = 60, fetcher = fetch } = {}) {
  const paths = [...new Set((iconPaths || []).map(gameIconPath).filter(Boolean))];

  if (paths.length === 0) {
    return { fetched: 0, skipped: 0, failed: 0 };
  }

  const entries = paths.map((path) => ({ key: iconCacheKey(path), path }));

  // Database first: anything already stored is skipped below and never requested
  // from UESP again. Chunked so a large inventory does not build one huge IN().
  const cached = new Set();
  const chunkSize = 250;

  for (let start = 0; start < entries.length; start += chunkSize) {
    const chunk = entries.slice(start, start + chunkSize);
    const [rows] = await connection.execute(
      `SELECT icon_key FROM itemshare_item_icons WHERE icon_key IN (${chunk.map(() => '?').join(', ')})`,
      chunk.map((entry) => entry.key)
    );
    for (const row of rows) {
      cached.add(row.icon_key);
    }
  }

  let fetched = 0;
  let failed = 0;

  for (const entry of entries) {
    if (cached.has(entry.key)) {
      continue;
    }
    if (fetched + failed >= limit) {
      break;
    }

    const url = iconSourceUrl(entry.path);
    if (!url) {
      continue;
    }

    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(8000) });

      if (!response.ok) {
        failed += 1;
        continue;
      }

      const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim();

      if (!contentType.startsWith('image/')) {
        failed += 1;
        continue;
      }

      const image = Buffer.from(await response.arrayBuffer());

      if (image.length === 0 || image.length > MAX_ICON_BYTES) {
        failed += 1;
        continue;
      }

      await connection.execute(
        `INSERT INTO itemshare_item_icons (icon_key, source_path, content_type, image_data)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE icon_key = icon_key`,
        [entry.key, entry.path, contentType, image]
      );
      fetched += 1;
    } catch {
      failed += 1;
    }
  }

  return { fetched, skipped: entries.length - fetched - failed, failed };
}

export async function getCachedIcon(connection, iconKey) {
  const key = String(iconKey || '');

  if (!/^[a-f0-9]{40}$/.test(key)) {
    return null;
  }

  const [rows] = await connection.execute(
    'SELECT content_type, image_data FROM itemshare_item_icons WHERE icon_key = ?',
    [key]
  );

  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Fallback for items whose captured icon path is empty (the client did not offer
// one) or absent (shares written before 1.5.0). The item id is enough: UESP's
// item page embeds the same mirror image, so the path can be recovered once and
// then cached like any other.

const ITEM_LOOKUP_URL = 'https://esoitem.uesp.net/itemLink.php?itemid=';

// Accept an absolute esoicons URL or a bare path, PNG or DDS, and normalise to
// the DDS path the addon itself would have captured. One code path then fetches
// and caches the PNG, so a recovered icon is indistinguishable from a captured
// one.
const ICON_PATH_PATTERN = /(\/esoui\/art\/icons\/[A-Za-z0-9_%/.-]+\.(?:png|dds))/i;

// UESP serves this texture for ids it has no icon for. Accepting it would give
// every unknown item the same generic picture and report success, hiding the gap
// instead of leaving it visible, so it counts as "no path".
const PLACEHOLDER_ICON = /\/icon_missing(_|\.)/i;

/** Game icon path found in a blob of text, as a .dds path, or '' when absent. */
export function normalizeIconPath(value) {
  const text = String(value || '');

  // Every occurrence, not just the first: a page can carry the placeholder and a
  // real icon, and the order is not ours to rely on.
  for (const match of text.matchAll(new RegExp(ICON_PATH_PATTERN.source, 'gi'))) {
    if (!PLACEHOLDER_ICON.test(match[1])) {
      return match[1].replace(/\.png$/i, '.dds');
    }
  }

  return '';
}

const ITEM_EXPORT_URL = 'https://esoitem.uesp.net/exportJson.php';

/**
 * Second source for one item's icon, through UESP's item database rather than its
 * item page. Set items are why this exists: their item page can answer without an
 * icon, while the mined summary row for the same id still carries one.
 */
export async function resolveIconPathFromItemExport(
  itemId,
  { fetcher = fetch, timeoutMs = 8000 } = {}
) {
  const id = Number(itemId);

  if (!Number.isFinite(id) || id <= 0) {
    return '';
  }

  try {
    const response = await fetcher(
      `${ITEM_EXPORT_URL}?table=minedItemSummary&id=${encodeURIComponent(id)}`,
      {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': 'ItemShare icon lookup' },
      }
    );

    if (!response.ok) {
      return '';
    }

    // The row's field names have moved before, so the path is found in the payload
    // rather than read from one guessed property.
    return normalizeIconPath(await response.text());
  } catch {
    return '';
  }
}

/**
 * Asks UESP for one item's icon path. Best effort: a missing page, a redirect, a
 * network failure or a page that no longer embeds an icon all return '' rather
 * than throwing, because an icon is never worth failing an upload over.
 *
 * Two endpoints are tried: the item link page first, then the item database, which
 * often answers for items the page has no icon for.
 */
export async function resolveIconPathByItemId(itemId, { fetcher = fetch, timeoutMs = 8000 } = {}) {
  const id = Number(itemId);

  if (!Number.isFinite(id) || id <= 0) {
    return '';
  }

  try {
    const response = await fetcher(`${ITEM_LOOKUP_URL}${id}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'ItemShare icon lookup' },
    });

    if (!response.ok) {
      return '';
    }

    const fromItemPage = normalizeIconPath(await response.text());
    if (fromItemPage) {
      return fromItemPage;
    }

    return resolveIconPathFromItemExport(id, { fetcher, timeoutMs });
  } catch {
    return '';
  }
}

/**
 * Fills in icon paths for entries that have none, keyed by item id, so one lookup
 * covers every copy of an item. `limit` bounds how many lookups one upload may
 * make: the rest stay blank and are retried by a later upload.
 *
 * @returns {Promise<{resolved: number, attempted: number, missing: number}>}
 */
export async function resolveMissingIconPaths(entries, { fetcher = fetch, limit = 40 } = {}) {
  const waiting = new Map();

  for (const entry of entries || []) {
    if (entry.icon) {
      continue;
    }
    const itemId = Number(entry.itemId);
    if (!Number.isFinite(itemId) || itemId <= 0) {
      continue;
    }
    if (!waiting.has(itemId)) {
      waiting.set(itemId, []);
    }
    waiting.get(itemId).push(entry);
  }

  let resolved = 0;
  let attempted = 0;

  for (const [itemId, group] of waiting) {
    if (attempted >= limit) {
      break;
    }
    attempted += 1;

    const icon = await resolveIconPathByItemId(itemId, { fetcher });
    if (!icon) {
      continue;
    }

    for (const entry of group) {
      entry.icon = icon;
    }
    resolved += 1;
  }

  return { resolved, attempted, missing: waiting.size };
}
