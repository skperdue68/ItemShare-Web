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
