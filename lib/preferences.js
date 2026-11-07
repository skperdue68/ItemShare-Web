// Reading preferences live in cookies, not in the address bar: the URL stays a plain
// link to the filters, so a link somebody shares never hands their sorting or their
// grouping to whoever opens it.

/** One cookie's decoded value, or '' when it is not there. */
export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.split('=');

    if (key && key.trim() === name) {
      return decodeURIComponent(rest.join('=').trim());
    }
  }

  return '';
}

/**
 * Whether the list is grouped under type headings. Grouping is on unless it was
 * deliberately turned off, so a missing, blank or unreadable cookie keeps the list
 * looking the way it always has.
 */
export function readGrouping(value) {
  return String(value || '').trim() !== '0';
}
