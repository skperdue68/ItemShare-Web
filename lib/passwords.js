// Email and password sign-in.
//
// A password is stored as scrypt with a per-password salt, as one string in the form
// scrypt$N$r$p$salt$hash: the parameters that made it travel with it, so raising the
// cost later cannot silently invalidate the rows written before it.
//
// Verification compares in constant time, and a stored row that cannot be read is a
// rejection rather than an exception - a damaged row must not turn into a 500 on the
// sign-in form.

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

const PREFIX = 'scrypt';
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const COST = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAX_EMAIL_LENGTH = 254;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

/** The address as it is stored and compared: trimmed and lower cased. */
export function normalizeEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .slice(0, MAX_EMAIL_LENGTH);
}

/**
 * Whether an address is worth spending a scrypt round trip on. Deliberately loose:
 * this is a typo check, not a claim that the mailbox exists, and a stricter pattern
 * would reject addresses that work.
 */
export function emailLooksValid(value) {
  const email = normalizeEmail(value);
  return email.includes('@') && email.length >= 6 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** @returns {Promise<string>} the hash, parameters included */
export async function hashPassword(password) {
  const text = String(password || '');

  if (text.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`);
  }
  if (text.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`Use at most ${MAX_PASSWORD_LENGTH} characters for the password.`);
  }

  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(text, salt, KEY_LENGTH, COST);

  return [
    PREFIX,
    COST.N,
    COST.r,
    COST.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/** @returns {Promise<boolean>} true only for the password that made this hash */
export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');

  if (parts.length !== 6 || parts[0] !== PREFIX) {
    return false;
  }

  const [, cost, blockSize, parallel, saltText, hashText] = parts;
  const salt = Buffer.from(saltText, 'base64');
  const expected = Buffer.from(hashText, 'base64');

  if (salt.length === 0 || expected.length === 0) {
    return false;
  }

  let derived;

  try {
    derived = await scrypt(String(password || ''), salt, expected.length, {
      N: Number(cost),
      r: Number(blockSize),
      p: Number(parallel),
      maxmem: COST.maxmem,
    });
  } catch {
    // A row written with parameters this build cannot run is not a match.
    return false;
  }

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
