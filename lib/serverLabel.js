// Where an ESO account lives: the platform it plays on and the megaserver it is on.
//
// A guild id and an @handle are only unique inside one of these, so the account list has
// to say which one it means - "PC" alone does not identify a megaserver, and "NA
// Megaserver" alone does not say whether it is a PC account or a console one.
//
// The numbers come from the addon's `platformRaw`. Only the value the site already
// records as PC is named here; any other value is shown as the raw number rather than
// guessed at, because printing "Xbox" beside an account whose file said something else
// would be worse than printing the number the file actually contained.

const PLATFORM_NAMES = new Map([[2, 'PC']]);

/** `PC`, the raw number when it is not one this site names, or '' when nothing was said. */
export function platformName(platform) {
  const id = Math.trunc(Number(platform) || 0);

  if (id === 0) {
    return '';
  }

  return PLATFORM_NAMES.get(id) || `platform ${id}`;
}

/**
 * The platform and megaserver as one line, e.g. `PC · NA Megaserver`.
 *
 * Either half may be missing - an account typed in by hand has neither until it uploads
 * once, and a file from an older addon has no world - so the line says only what is
 * known, and '' when nothing is.
 */
export function serverLabel({ platform = 0, worldName = '' } = {}) {
  const name = platformName(platform);
  const world = String(worldName || '').trim();

  if (name && world) {
    return `${name} \u00b7 ${world}`;
  }

  return name || world;
}

/**
 * The megaservers the site knows before anybody uploads. The addon writes the one it ran
 * on, so these are only what a PC account can be on; they are offered beside the servers
 * already recorded, so the attach form works before the first file arrives.
 */
export const KNOWN_SERVERS = [
  { platform: 2, worldName: 'NA Megaserver' },
  { platform: 2, worldName: 'EU Megaserver' },
];

/**
 * What the attach form offers: every platform and server already recorded, plus the known
 * ones, each value once. Values come from the database rather than a fixed list, because
 * a server this site has never heard of is still a server somebody's account is on.
 */
export function serverChoices(rows = []) {
  const platforms = new Map();
  const worlds = new Set();

  for (const row of [...KNOWN_SERVERS, ...(Array.isArray(rows) ? rows : [])]) {
    const platform = Math.trunc(Number(row && row.platform)) || 0;
    const worldName = String((row && row.worldName) || '').trim();

    if (platform > 0 && !platforms.has(platform)) {
      platforms.set(platform, platformName(platform));
    }

    if (worldName) {
      worlds.add(worldName);
    }
  }

  return {
    platforms: [...platforms]
      .map(([value, name]) => ({ value, label: name }))
      .sort((a, b) => a.value - b.value),
    worlds: [...worlds].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * The platform and server an attach form sent, or null when either is missing.
 * Platform 0 means "no file has said yet", which is the state the form exists to end.
 */
export function readAccountServer(body = {}) {
  const platform = Math.trunc(Number(body && body.platform)) || 0;
  const worldName = String((body && body.worldName) || '')
    .trim()
    .slice(0, 64);

  if (platform <= 0 || !worldName) {
    return null;
  }

  return { platform, worldName };
}
