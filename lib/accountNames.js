// The one place a typed-in ESO account name is made the same shape as the addon's.
//
// The saved variables file writes accounts as "@name" - lower case, no spaces - and
// everything that compares one (links, guild membership, requests) compares strings.
// A person typing their own name into a box has no idea of that convention, so it is
// normalised here instead of being refused: trimmed, lower cased, one @ in front,
// spaces dropped, and anything that cannot be in a name removed.

const MAX_LENGTH = 64;

/** @returns {string} "@name", or '' when nothing usable was typed */
export function normalizeEsoAccountName(value) {
  const name = String(value || '')
    .trim()
    .toLowerCase()
    // Leading @ signs are added back below, so "@@Name" and "Name" agree.
    .replace(/^@+/, '')
    // A space is never part of a name; people paste names with them.
    .replace(/\s+/g, '')
    // Letters, digits, apostrophe, hyphen, underscore: what ESO names are made of.
    .replace(/[^a-z0-9'_-]/g, '')
    .slice(0, MAX_LENGTH);

  return name ? `@${name}` : '';
}
