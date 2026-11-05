// Repairs icons that an upload could not resolve.
//
// Icon lookup is best effort: UESP can be down, refuse this host, change its page,
// or the upload can hit its per-request budget. Nothing about those cases changes
// later, so without a retry the item would stay a placeholder for ever - the only
// trigger for a lookup used to be somebody uploading a file.
//
// This pass closes that gap: it asks the database which item ids are still blank,
// looks those up on UESP, writes the paths back and caches the PNGs. It is bounded
// per run and safe to call on a timer: a second pass before the first finishes
// would find nothing new to do, and a failed lookup simply stays blank for the next
// run.
//
// It also repairs a second kind of gap: rows that do have an icon path but no image
// behind it. Those were treated as done, so the page stayed blank for ever even
// though UESP knew the item. One answer is enough - the same id, asked again through
// the item database instead of the item page.

import { cacheItemIcons, resolveIconPathByItemId } from './icons.js';
import { fillIconsByItemId, getItemIdsMissingIcons, getUncachedIconItems } from './store.js';

const NO_ICONS = { fetched: 0, skipped: 0, failed: 0 };

/**
 * @returns {Promise<{itemIds: number, resolved: number, rows: number, icons: object}>}
 *   `itemIds` looked up, `resolved` found a path, `rows` item rows updated.
 */
export async function backfillItemIcons(connection, { fetcher = fetch, limit = 20 } = {}) {
  const batch = Math.min(Math.max(Math.trunc(Number(limit)) || 20, 1), 200);
  const blankIds = await getItemIdsMissingIcons(connection, batch);
  const uncached = blankIds.length >= batch
    ? []
    : await getUncachedIconItems(connection, batch - blankIds.length);

  // A path that is stored but has no image is only worth replacing with a different
  // answer: asking UESP again for the same path would fail the same way and loop.
  const blank = new Set(blankIds);
  const unfetchable = new Map();

  for (const row of uncached) {
    if (!blank.has(row.itemId)) {
      unfetchable.set(row.itemId, row.icon);
    }
  }

  const itemIds = [...new Set([...blank, ...unfetchable.keys()])];

  if (itemIds.length === 0) {
    return { itemIds: 0, resolved: 0, rows: 0, icons: NO_ICONS };
  }

  const paths = new Map();

  for (const itemId of itemIds) {
    const icon = await resolveIconPathByItemId(itemId, { fetcher });

    if (!icon) {
      continue;
    }
    if (unfetchable.get(itemId) === icon) {
      continue;
    }

    paths.set(itemId, icon);
  }

  const rows = await fillIconsByItemId(connection, paths, { replaceUncached: true });
  const icons = paths.size
    ? await cacheItemIcons(connection, [...paths.values()], { fetcher })
    : NO_ICONS;

  return { itemIds: itemIds.length, resolved: paths.size, rows, icons };
}
