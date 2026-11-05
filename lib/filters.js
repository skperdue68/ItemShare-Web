// A filter that can hold more than one value arrives from the address bar in
// several shapes: once for a single choice, repeated for two, or already an array
// from Express. All of them become one clean list here, so the page, the query and
// the chips under the filter row agree on what is switched on.

export function filterList(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  const seen = new Set();

  for (const entry of raw) {
    const text = String(entry ?? '').trim();

    if (text) {
      seen.add(text);
    }
  }

  return [...seen];
}
