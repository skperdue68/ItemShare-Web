// The item list's order, as a queue of columns rather than one.
//
// A press on a heading does one of three things: a column that is off joins the end of
// the queue ascending; a column already in it reverses where it stands, keeping its turn;
// a third press takes it out and everything behind it moves up. Because the queue is the
// order the headings were pressed, "Item then Type" is a different table from "Type then
// Item", and both are reachable.
//
// The queue lives in a cookie, never the address bar: an order is a reading preference,
// and a shared link should not carry somebody else's. It is read back here on the server,
// so a page load, a live refresh and a search all arrive already ordered - nothing in the
// browser has to re-sort a table the server has just sent.

// Every column that sorts, and nothing else: a hand-typed cookie or ?sort= that names
// something odd falls back to the default rather than reaching a query.
export const SORT_FIELDS = ['name', 'added', 'type', 'trait', 'location', 'owner'];

// What the headings are called, for the spoken label. The visible heading can be
// upper-cased by CSS; a screen reader should not hear it shouted.
export const SORT_LABELS = {
  name: 'Item',
  added: 'Added',
  type: 'Type',
  trait: 'Trait',
  location: 'Location',
  owner: 'Offered by',
};

/**
 * The queue a cookie holds, with anything unreadable dropped rather than guessed at.
 *
 * `name:asc,type:desc` is "by name, then by type". A field that repeats keeps its first
 * turn only: a column cannot stand in the queue twice.
 */
export function parseSortOrder(value) {
  const order = [];

  for (const part of String(value || '').split(',')) {
    const [field, dir] = part.split(':').map((piece) => piece.trim());

    if (!SORT_FIELDS.includes(field) || (dir !== 'asc' && dir !== 'desc')) continue;
    if (order.some((entry) => entry.field === field)) continue;

    order.push({ field, dir });
  }

  return order;
}

/**
 * Where a column stands in the queue: 1 for the one that decides, 2 for the one that only
 * breaks its ties, and so on. Null when the column is off.
 *
 * Read from the queue every time the headings are drawn rather than kept beside them,
 * which is what renumbers the ones behind a column that is switched off.
 */
export function queuePlace(order, field) {
  const at = (order || []).findIndex((entry) => entry.field === field);

  return at === -1 ? null : { rank: at + 1, dir: order[at].dir };
}
