import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import {
  HASH_PREFIX,
  LEGACY_RECOVERY_HASH_PREFIX,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
} from '../constants/index.js';

const scryptAsync = promisify(scrypt);

const DERIVED_KEY_LENGTH = 32;

// Crockford style base32 without I, L, O and U, so a code read out loud or
// copied from a printout cannot be mistyped.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(RECOVERY_CODE_LENGTH);
    let code = '';

    for (let i = 0; i < RECOVERY_CODE_LENGTH; i += 1) {
      code += ALPHABET[bytes[i] % ALPHABET.length];
    }

    return code;
  });
}

/**
 * Recovery codes are bearer credentials, so they are stored the same way user
 * passwords are: scrypt with a per-code salt, never in the clear.
 *
 * These were SHA-256, which is the wrong tool for the same reason `deriveKey`
 * was. A code is ten characters of a 32 symbol alphabet — about 50 bits — and
 * against a leaked table of those, SHA-256 runs at billions of hashes a second
 * on a GPU. Fifty bits stops being a lot of guessing when the guessing is free.
 * scrypt puts the cost back where the entropy claim actually needs it.
 *
 * **Cost of the fix.** Verification walks the stored codes until one matches, so
 * a wrong code costs one derivation per remaining code — about ten. At the same
 * scrypt settings a password uses, that is roughly a second for a wrong guess and
 * two for a right one, on a path taken a handful of times before the lockout.
 * That is the right place for the expense: a recovery code is exactly the
 * credential an attacker with the database wants, and exactly the one a legitimate
 * user reaches for when nothing else works.
 *
 * `sha256$` values written by an older deployment still verify. They are never
 * written, so they age out as codes are spent, and there is no migration to run.
 */
export async function hashRecoveryCode(code: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scryptAsync(
    code,
    salt,
    DERIVED_KEY_LENGTH,
  )) as Buffer;

  return `${HASH_PREFIX}$${salt}:${derivedKey.toString('hex')}`;
}

export async function verifyRecoveryCode(
  code: string,
  stored: string,
): Promise<boolean> {
  const separator = stored.indexOf('$');

  if (separator < 0) {
    return false;
  }

  const prefix = stored.slice(0, separator);

  // The legacy path is a plain digest and has to stay a plain digest: deriving it
  // with scrypt would compare two different functions and never match.
  return prefix === LEGACY_RECOVERY_HASH_PREFIX
    ? verifyLegacy(code, stored.slice(separator + 1))
    : verifyScrypt(code, stored.slice(separator + 1));
}

async function verifyScrypt(code: string, body: string): Promise<boolean> {
  const [salt, expected] = body.split(':');

  if (!salt || !expected) {
    return false;
  }

  const derivedKey = (await scryptAsync(
    code,
    salt,
    DERIVED_KEY_LENGTH,
  )) as Buffer;
  const expectedBuffer = Buffer.from(expected, 'hex');

  if (expectedBuffer.length !== derivedKey.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, derivedKey);
}

function verifyLegacy(code: string, body: string): Promise<boolean> {
  const [salt, expected] = body.split(':');

  if (!salt || !expected) {
    return Promise.resolve(false);
  }

  const actual = createHash('sha256')
    .update(`${LEGACY_RECOVERY_HASH_PREFIX}$${salt}:${code}`)
    .digest('hex');
  const actualBuffer = Buffer.from(actual, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');

  if (actualBuffer.length !== expectedBuffer.length) {
    return Promise.resolve(false);
  }

  return Promise.resolve(timingSafeEqual(expectedBuffer, actualBuffer));
}
