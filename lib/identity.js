// Provider profile -> avatar URL.
//
// Discord returns an avatar hash, not a URL; Google returns a full picture URL. Both
// are normalised here so the header does not need to know who signed in.
//
// Only https URLs are kept. The value ends up in an <img src>, so a javascript: or
// data: URL from a profile must never reach the page, and because it is also stored
// and rendered later it is length limited too.

const MAX_AVATAR_URL = 512;
const DISCORD_CDN = 'https://cdn.discordapp.com';

/** The value if it is an https URL we are willing to put in an img src, else ''. */
export function sanitizeAvatarUrl(value) {
  const url = String(value || '').trim();

  if (!url.startsWith('https://') || url.length > MAX_AVATAR_URL) {
    return '';
  }

  return url;
}

/** Discord avatar URL for a /users/@me profile, or '' when there is no picture. */
export function discordAvatarUrl(profile) {
  const id = profile && profile.id ? String(profile.id) : '';
  const hash = profile && typeof profile.avatar === 'string' ? profile.avatar.trim() : '';

  if (!id || !hash) {
    return '';
  }

  // Animated avatars are GIFs and their hash says so with an a_ prefix.
  const extension = hash.startsWith('a_') ? 'gif' : 'png';

  return sanitizeAvatarUrl(
    `${DISCORD_CDN}/avatars/${encodeURIComponent(id)}/${encodeURIComponent(hash)}.${extension}?size=64`
  );
}

/** Google profile picture for an OpenID userinfo response, or '' when absent. */
export function googleAvatarUrl(profile) {
  return sanitizeAvatarUrl(profile && profile.picture);
}
