// The code a guild member hands to somebody they want in, in a shape a person can read
// out loud.
//
// A code is a bearer secret: whoever types it gets to see what that guild shares. So it
// is long enough that guessing is hopeless - eight characters from a thirty-one character
// alphabet is about forty bits, and the site makes no more than one guess per request.
//
// It is also made of characters that survive being written on paper, typed off a screen
// and read over voice chat: no I, no L, no O, no 0, no 1. Those five are the pairs people
// get wrong, and a code somebody cannot type is a code that has to be replaced.
//
// Normalising is forgiving in one direction only. Case, spaces, dashes and any other
// punctuation are dropped, because they are how a code is copied around; characters that
// are not in the alphabet are not mapped onto one, because "O" could be the letter or the
// number and guessing would make two different codes the same code.

import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const DASH_AT = 4;

/** What was typed, as the code it must have meant: upper case, letters and digits only. */
export function normalizeGuildCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, CODE_LENGTH);
}

/** The code split in two, which is how it is written down and printed. */
export function formatGuildCode(value) {
  const code = normalizeGuildCode(value);

  return code.length === CODE_LENGTH ? `${code.slice(0, DASH_AT)}-${code.slice(DASH_AT)}` : code;
}

/** Whether this is a code the site could have made. */
export function isGuildCode(value) {
  const code = normalizeGuildCode(value);

  if (code.length !== CODE_LENGTH) {
    return false;
  }

  return [...code].every((character) => ALPHABET.includes(character));
}

/**
 * Turns random bytes into a code, one character per byte.
 *
 * A byte is taken modulo the alphabet, so the bytes from the last incomplete block would
 * make the first few characters slightly likelier than the rest. Those bytes are skipped
 * instead: the code is either a fair pick from every character or it is not made here.
 *
 * @param {Uint8Array|Buffer} bytes at least eight usable bytes; sixteen is generous
 * @returns {string} eight characters, or fewer when the bytes ran out - the caller asks again
 */
export function makeGuildCode(bytes) {
  const limit = 256 - (256 % ALPHABET.length);
  let code = '';

  for (const byte of bytes) {
    if (byte >= limit) {
      continue;
    }

    code += ALPHABET[byte % ALPHABET.length];

    if (code.length === CODE_LENGTH) {
      return code;
    }
  }

  return code;
}

/** A fresh code, or a thrown error in the impossible case that randomness kept failing. */
export function newGuildCode() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = makeGuildCode(randomBytes(CODE_LENGTH * 2));

    if (code.length === CODE_LENGTH) {
      return code;
    }
  }

  throw new Error('Could not make a guild code: no usable random bytes.');
}
