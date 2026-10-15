import { createHash, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
} from './recovery-code.util.js';
import { RECOVERY_CODE_LENGTH } from '../constants/index.js';

const CODE = 'H4KM9QRTVZ';

describe('generateRecoveryCodes', () => {
  it('produces the requested count', () => {
    expect(generateRecoveryCodes(4)).toHaveLength(4);
  });

  it('uses no symbol a human mistypes', () => {
    // No I, L, O or U — a code read aloud or copied off a printout should not be
    // able to contain a character two of them look like.
    for (const code of generateRecoveryCodes(20)) {
      expect(code).not.toMatch(/[ILOU]/);
      expect(code).toHaveLength(RECOVERY_CODE_LENGTH);
    }
  });

  it('does not repeat itself', () => {
    const codes = generateRecoveryCodes(20);

    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('hashRecoveryCode', () => {
  it('names its derivation, so an older value can still be read', async () => {
    const stored = await hashRecoveryCode(CODE);

    expect(stored.startsWith('scrypt$')).toBe(true);
  });

  it('never stores the code', async () => {
    const stored = await hashRecoveryCode(CODE);

    expect(stored).not.toContain(CODE);
  });

  it('salts, so the same code stored twice is two different rows', async () => {
    const [a, b] = await Promise.all([
      hashRecoveryCode(CODE),
      hashRecoveryCode(CODE),
    ]);

    expect(a).not.toBe(b);
  });

  it('round-trips through verify', async () => {
    expect(await verifyRecoveryCode(CODE, await hashRecoveryCode(CODE))).toBe(
      true,
    );
  });

  it('rejects the wrong code', async () => {
    expect(
      await verifyRecoveryCode('AAAAAAAAAA', await hashRecoveryCode(CODE)),
    ).toBe(false);
  });

  it('is not a bare digest of the code', async () => {
    // The regression this replaced. A leaked table of these was fifty bits of
    // entropy against a hash a GPU computes billions of times a second, which is
    // not fifty bits of defence.
    const stored = await hashRecoveryCode(CODE);
    const bare = createHash('sha256').update(CODE).digest('hex');

    expect(stored).not.toContain(bare);
  });
});

describe('verifyRecoveryCode', () => {
  it('still accepts a value written by the previous implementation', async () => {
    // The compatibility that matters: a deployment that upgrades must not strand
    // the users holding the codes they were already given. Same salt, same digest
    // shape, and the prefix is what tells it apart.
    const salt = randomBytes(16).toString('hex');
    const legacy = `sha256$${salt}:${createHash('sha256')
      .update(`sha256$${salt}:${CODE}`)
      .digest('hex')}`;

    expect(await verifyRecoveryCode(CODE, legacy)).toBe(true);
    expect(await verifyRecoveryCode('AAAAAAAAAA', legacy)).toBe(false);
  });

  it('refuses a malformed value rather than throwing', async () => {
    for (const stored of [
      '',
      'nonsense',
      'scrypt$',
      'scrypt$nosalt',
      'a$b:c',
    ]) {
      expect(await verifyRecoveryCode(CODE, stored)).toBe(false);
    }
  });
});
