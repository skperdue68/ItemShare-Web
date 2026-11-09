// How old the offers in a demo or a simulation look.
//
// Every row written by replaceAccounts starts at "just now", because that is when the
// file confirmed it. That is right for a real upload, but a shelf where every item was
// added in the same second says nothing about the one thing the Added column exists to
// say: an offer keeps the date it was first made, while new offers arrive beside it.
//
// So a demo or a simulation staggers the dates of the rows it has just created - and only
// those. A row whose first_seen_at and last_seen_at still match has not been touched since
// it was inserted, so it gets one of the ages below and is never staggered again; from
// then on it keeps that date for as long as it stays shared, even as the next save adds
// new rows beside it. That is the same rule a real upload follows, with a curated spread
// of starting dates instead of everything stamped today.

/**
 * The ages a fresh set of rows is spread across, in hours: a few months down to a few
 * hours. The ladder is only used for rows created in one go, so it says what a plausible
 * shelf looks like rather than describing any real date.
 */
export const AGE_HOURS = [
  84 * 24,
  63 * 24,
  45 * 24,
  33 * 24,
  24 * 24,
  17 * 24,
  12 * 24,
  8 * 24,
  5 * 24,
  3 * 24,
  30,
  6,
];

/**
 * One age per row, oldest first, spread across the whole ladder.
 *
 * Scaling by the count rather than taking the ladder in order is what keeps a three-row
 * account showing the same kind of spread as a twelve-row one: 84 days, 17 days and six
 * hours, instead of three ages a few weeks apart.
 */
export function planAges(count) {
  const total = Math.max(0, Math.trunc(Number(count) || 0));

  if (total === 0) {
    return [];
  }

  const last = AGE_HOURS.length - 1;

  return Array.from({ length: total }, (_, index) =>
    AGE_HOURS[total === 1 ? 0 : Math.round((index * last) / (total - 1))]
  );
}

/** The tables whose rows carry their own first_seen_at/last_seen_at pair. */
export const AGED_TABLES = ['itemshare_shared_items', 'itemshare_always_share'];

/**
 * The rows a save has just created, and only those.
 *
 * `first_seen_at = last_seen_at` is the whole safety of the staggering: it can only hold
 * for a row nobody has updated since it was inserted, so asking twice dates nothing the
 * second time, and a row that keeps being re-saved keeps the date it was given first.
 */
export function untouchedRowsSql(table) {
  if (!AGED_TABLES.includes(table)) {
    throw new Error(`Refusing to stagger a table that has no living dates: ${table}`);
  }

  return `SELECT id FROM ${table}
           WHERE account_name = ? AND first_seen_at = last_seen_at
           ORDER BY item_name ASC, id ASC`;
}

/**
 * Dates the rows this save just created, and leaves every older row alone.
 *
 * The condition is the whole safety of it: `first_seen_at = last_seen_at` can only hold
 * for a row nobody has updated since it was inserted, so running this twice does nothing
 * the second time, and a row that keeps being re-saved keeps the date it was given first.
 *
 * @returns {Promise<number>} how many rows were dated
 */
export async function staggerFirstSeen(
  connection,
  { accountNames = [], tables = AGED_TABLES, now = null } = {}
) {
  const names = [...new Set((accountNames || []).map((name) => String(name || '').trim()).filter(Boolean))];

  if (names.length === 0) {
    return 0;
  }

  let dated = 0;
  const when = now instanceof Date ? now : new Date();

  for (const table of tables) {
    // Ordered by name so the same item lands on the same rung from one fresh database
    // to the next; the ladder itself is what makes the list look lived in.
    const sql = untouchedRowsSql(table);

    for (const name of names) {
      const [rows] = await connection.execute(sql, [name]);
      const ages = planAges(rows.length);

      for (let index = 0; index < rows.length; index += 1) {
        const at = new Date(when.getTime() - ages[index] * 3600 * 1000);

        await connection.execute(`UPDATE ${table} SET first_seen_at = ? WHERE id = ?`, [
          at,
          rows[index].id,
        ]);
        dated += 1;
      }
    }
  }

  return dated;
}
