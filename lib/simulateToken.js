// The eight characters both sides print when they talk about SIMULATE_TOKEN.
//
// The site and `npm run simulate` each reported their own fingerprint, computed by their
// own copy of this function, so the two numbers were only comparable for as long as two
// implementations stayed identical - and when they stopped being identical, "the tokens
// do not match" was the message even though the tokens were fine. One function, imported
// by both, makes the comparison mean what it says.
//
// A hash prefix, never the token: enough to line two log lines up, useless to anybody
// who reads the log without already holding the token.

import { createHash } from 'node:crypto';

export function tokenFingerprint(value) {
  const trimmed = String(value || '').trim();

  return trimmed ? createHash('sha1').update(trimmed).digest('hex').slice(0, 8) : 'none';
}
