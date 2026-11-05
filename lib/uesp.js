// What an item is, beyond what the addon could capture: the game's own description
// and what the item's set does.
//
// UESP answers both from its public item database (`exportJson.php`, no key), but it
// is somebody else's server: every answer is cached in MariaDB for a month, so a
// name is fetched once and hovering it afterwards costs nothing. Every failure here
// returns an empty answer rather than throwing - a hover card must never be able to
// break a page.

const EXPORT_URL = 'https://esoitem.uesp.net/exportJson.php';
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const TIMEOUT_MS = 8000;

/** One cache row per card: item id and set name together, because a card shows both. */
export function tipCacheKey({ itemId = 0, setName = '' } = {}) {
  const id = Math.max(0, Math.trunc(Number(itemId) || 0));
  return `item:${id}|set:${String(setName || '').trim().toLowerCase().slice(0, 120)}`;
}

function firstRow(payload, table) {
  const rows = payload && Array.isArray(payload[table]) ? payload[table] : [];
  return rows[0] || null;
}

/** UESP keeps set bonuses as up to twelve numbered columns, blank when unused. */
function setBonusesFrom(row) {
  const bonuses = [];

  for (let index = 1; index <= 12; index += 1) {
    const text = String(row[`setBonusDesc${index}`] || '').trim();

    if (text) {
      bonuses.push(text);
    }
  }

  return bonuses;
}

async function requestTable(fetcher, { table, id }, timeoutMs) {
  const url = `${EXPORT_URL}?table=${encodeURIComponent(table)}&id=${encodeURIComponent(id)}`;

  try {
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'ItemShare item tooltip' },
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Asks UESP about one item, and about its set when the item itself does not carry
 * the bonus lines.
 *
 * @returns {Promise<{itemId: number, setName: string, available: boolean, fromUesp: boolean,
 *   unique: boolean, description: string, traitDesc: string,
 *   set: null | {name: string, maxEquip: number, type: string, sources: string, bonuses: string[]}}>}
 */
export async function fetchItemTip(
  { itemId = 0, setName = '' },
  { fetcher = fetch, timeoutMs = TIMEOUT_MS } = {}
) {
  const id = Math.max(0, Math.trunc(Number(itemId) || 0));
  const wantedSet = String(setName || '').trim();
  const tip = {
    itemId: id,
    setName: wantedSet,
    available: true,
    fromUesp: true,
    unique: false,
    description: '',
    traitDesc: '',
    set: null,
  };

  if (id > 0) {
    const row = firstRow(
      await requestTable(fetcher, { table: 'minedItemSummary', id }, timeoutMs),
      'minedItemSummary'
    );

    if (row) {
      tip.description = String(row.description || '').trim();
      tip.traitDesc = String(row.traitDesc || '').trim();
      tip.unique = String(row.isUnique) === '1';

      const rowSet = String(row.setName || '').trim() || wantedSet;
      const bonuses = setBonusesFrom(row);

      if (rowSet && bonuses.length > 0) {
        tip.setName = rowSet;
        tip.set = {
          name: rowSet,
          maxEquip: Number(row.setMaxEquipCount) || bonuses.length + 1,
          type: '',
          sources: '',
          bonuses,
        };
      } else if (rowSet) {
        tip.setName = rowSet;
      }
    }
  }

  if (!tip.set && tip.setName) {
    const row = firstRow(
      await requestTable(fetcher, { table: 'setSummary', id: tip.setName }, timeoutMs),
      'setSummary'
    );

    if (row) {
      const bonuses = setBonusesFrom(row);
      tip.set = {
        name: String(row.setName || tip.setName),
        maxEquip: Number(row.setMaxEquipCount) || bonuses.length + 1,
        type: String(row.type || '').trim(),
        sources: String(row.sources || '').trim(),
        bonuses,
      };
    }
  }

  // Nothing usable came back (a wrong item id, an outage): say so instead of handing
  // the card an empty shell it would render as if it were the whole story.
  if (!tip.description && !tip.traitDesc && !tip.set) {
    tip.available = false;
  }

  return tip;
}

/**
 * The answer a hover card needs, from cache when it is fresh. A missing or broken
 * cache table is ignored: the lookup still works, it is just repeated next time.
 */
export async function getItemTip(
  connection,
  { itemId = 0, setName = '' },
  { fetcher = fetch, cacheTtlSeconds = CACHE_TTL_SECONDS } = {}
) {
  const key = tipCacheKey({ itemId, setName });

  try {
    const [rows] = await connection.execute(
      `SELECT payload, TIMESTAMPDIFF(SECOND, fetched_at, NOW()) AS age
         FROM itemshare_item_tips
        WHERE tip_key = ?
        LIMIT 1`,
      [key]
    );

    const cached = rows[0];
    const age = Number(cached && cached.age);

    if (cached && Number.isFinite(age) && age >= 0 && age < cacheTtlSeconds) {
      return { ...JSON.parse(String(cached.payload)), cached: true };
    }
  } catch {
    // No cache table yet, or a database hiccup: fall through and ask UESP.
  }

  const tip = await fetchItemTip({ itemId, setName }, { fetcher });

  if (tip.available) {
    try {
      await connection.execute(
        `INSERT INTO itemshare_item_tips (tip_key, payload)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE payload = VALUES(payload), fetched_at = CURRENT_TIMESTAMP`,
        [key, JSON.stringify(tip)]
      );
    } catch {
      // Caching is an optimisation, not a requirement.
    }
  }

  return tip;
}
