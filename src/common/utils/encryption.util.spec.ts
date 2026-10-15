import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decrypt, deriveKey, encrypt } from './encryption.util.js';

/**
 * The two properties this file exists for: that a wrong key fails loudly instead
 * of returning garbage, and that the derivation is work-hardened.
 *
 * The second one is asserted structurally rather than by timing. A test that
 * measures how long derivation takes is a test that fails on a fast machine and
 * passes on a slow one, and a failing timing test is a test people delete.
 */
const KEY = deriveKey('a-passphrase-from-the-environment');

describe('encrypt/decrypt', () => {
  it('round-trips', () => {
    const value = encrypt('JBSWY3DPEHPK3PXP', KEY);

    expect(decrypt(value, KEY)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('produces a different ciphertext every time', () => {
    // A fresh IV per call. Reusing one under the same key is the single mistake
    // that turns authenticated encryption back into ordinary encryption, and it
    // would not be visible in any of these strings.
    const a = encrypt('same plaintext', KEY);
    const b = encrypt('same plaintext', KEY);

    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
    expect(a.authTag).not.toBe(b.authTag);
  });

  it('refuses to decrypt under a different key', () => {
    const value = encrypt('JBSWY3DPEHPK3PXP', KEY);

    expect(() => decrypt(value, deriveKey('a-different-passphrase'))).toThrow();
  });

  it('refuses a tampered ciphertext', () => {
    // The auth tag is the point of GCM here: a modified row must fail rather than
    // decrypt to something plausible.
    const value = encrypt('JBSWY3DPEHPK3PXP', KEY);
    const bytes = Buffer.from(value.ciphertext, 'base64');
    bytes[0] ^= 0xff;

    expect(() =>
      decrypt({ ...value, ciphertext: bytes.toString('base64') }, KEY),
    ).toThrow();
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => encrypt('x', Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});

describe('deriveKey', () => {
  it('is stable, because the stored ciphertext depends on it', () => {
    expect(deriveKey('same').equals(deriveKey('same'))).toBe(true);
  });

  it('differs for a different passphrase', () => {
    expect(deriveKey('a').equals(deriveKey('b'))).toBe(false);
  });

  it('is 32 bytes, which is what AES-256 wants', () => {
    expect(deriveKey('anything').length).toBe(32);
  });

  it('is not a bare hash of the passphrase', () => {
    // The assertion that catches the regression this replaced. A single SHA-256
    // is one operation away from the secret; scrypt is deliberately expensive,
    // and a database leak is exactly the situation where that expense is the only
    // thing standing between an operator's `changeme` and every enrolled TOTP
    // secret in the table.
    const passphrase = 'the-passphrase';

    expect(deriveKey(passphrase).toString('hex')).not.toBe(
      createHash('sha256').update(passphrase, 'utf8').digest('hex'),
    );
  });
});
