// Sign-in providers.
//
// These used to live inline in server.js, which meant the profile mapping - the part
// that turns a Discord or Google response into our own fields, including the avatar
// URL - could only be reached by completing a real OAuth round trip. It is a pure
// function of the profile, so it lives here and is tested directly.

import { discordAvatarUrl, googleAvatarUrl } from './identity.js';

const DISCORD = {
  label: 'Discord',
  envPrefix: 'DISCORD',
  authorizeUrl: 'https://discord.com/oauth2/authorize',
  tokenUrl: 'https://discord.com/api/oauth2/token',
  profileUrl: 'https://discord.com/api/users/@me',
  scope: 'identify email',
  readProfile(profile) {
    return {
      providerUserId: String(profile.id),
      username: profile.global_name || profile.username || String(profile.id),
      email: typeof profile.email === 'string' ? profile.email : '',
      emailVerified: profile.verified === true,
      // Discord sends an avatar hash, not a URL.
      avatarUrl: discordAvatarUrl(profile),
    };
  },
};

const GOOGLE = {
  label: 'Google',
  envPrefix: 'GOOGLE',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  profileUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
  scope: 'openid email profile',
  readProfile(profile) {
    return {
      providerUserId: String(profile.sub),
      username: profile.name || profile.email || String(profile.sub),
      email: typeof profile.email === 'string' ? profile.email : '',
      emailVerified: profile.email_verified === true,
      // Google sends a full picture URL.
      avatarUrl: googleAvatarUrl(profile),
    };
  },
};

export const PROVIDER_DEFINITIONS = { discord: DISCORD, google: GOOGLE };

/**
 * Providers with their credentials filled in from the environment.
 * A provider with no client id or secret is present but not configured, so the site
 * can say so instead of offering a button that cannot work.
 */
export function buildProviders(env = process.env) {
  const baseUrl = env.BASE_URL || `http://localhost:${Number(env.PORT || 3000)}`;
  const providers = {};

  for (const [key, definition] of Object.entries(PROVIDER_DEFINITIONS)) {
    const prefix = definition.envPrefix;
    const clientId = env[`${prefix}_CLIENT_ID`] || '';
    const clientSecret = env[`${prefix}_CLIENT_SECRET`] || '';

    providers[key] = {
      ...definition,
      key,
      clientId,
      clientSecret,
      configured: Boolean(clientId && clientSecret),
      redirectUri: env[`${prefix}_REDIRECT_URI`] || `${baseUrl}/auth/${key}/callback`,
    };
  }

  return providers;
}
