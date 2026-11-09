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

/**
 * What is wrong with the second copy of a password, or '' when the two agree.
 *
 * Creating an account asks for the password twice, and the browser is not the only thing
 * that has to check: a form posts whether or not a script ever ran, so the server reads
 * both boxes and refuses a pair that disagrees instead of quietly keeping the first.
 *
 * An empty second box is not treated as "no confirmation asked for" on the sign-up form -
 * that form always has the box - so the message says to type it again rather than
 * comparing against nothing.
 */
export function passwordConfirmationProblem(password, confirm) {
  const second = String(confirm == null ? '' : confirm);

  if (second.length === 0) {
    return 'Type the password again in the second box, so a typo cannot lock you out.';
  }

  if (second !== String(password == null ? '' : password)) {
    return 'Those two passwords are not the same. Retype both of them, and mind the capitals.';
  }

  return '';
}

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

/**
 * @param {string} password
 * @param {{allowShort?: boolean}} [options] `allowShort` exists for one identity only:
 *   the demo sign-in, whose password is deliberately short and is not a person's
 *   account. Every form-made password still has to pass the minimum.
 * @returns {Promise<string>} the hash, parameters included
 */
export async function hashPassword(password, { allowShort = false } = {}) {
  const text = String(password || '');

  if (!allowShort && text.length < MIN_PASSWORD_LENGTH) {
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
