import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as OTPAuth from 'otpauth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RECOVERY_CODE_COUNT,
  TOTP_ALGORITHM,
  TOTP_DIGITS,
  TOTP_PERIOD,
} from '../../common/constants/index.js';
import { decrypt, deriveKey, encrypt } from '../../common/utils/index.js';
import { TwoFactorService } from './two-factor.service.js';
import type { TwoFactorSecret } from './entities/index.js';

/**
 * The second factor, as a unit.
 *
 * The property worth testing is not "a code is accepted" — `otpauth` does that —
 * but what this service adds around it: a code is spent once, a replay is
 * refused, a recovery code is removed when it is used, repeated failures lock the
 * factor for a while, and a challenge token for one account cannot be replayed
 * against another.
 *
 * The secret is encrypted and decrypted for real here, with a real key. A stubbed
 * cipher would make the one part that can silently lose an account — a secret
 * that cannot be recovered after a restart — untested.
 */

const ENCRYPTION_KEY = 'test-two-factor-encryption-key-32!!';
const BASE32 = OTPAuth.Secret.fromBase32('JBSWY3DPEHPK3PXP').base32;

const ISSUER = 'Boilerplate';
const ACCOUNT = 'user-id-1';

type Options = {
  enabled?: boolean;
  record?: Partial<TwoFactorSecret> | null;
};

function harness(options: Options = {}) {
  const { enabled = true } = options;

  const stored: Record<string, unknown> = {};

  const repository = {
    create: vi.fn((values: Record<string, unknown>) => ({
      id: 'row-1',
      ...values,
    })),
    save: vi.fn(async (record: TwoFactorSecret) => {
      Object.assign(stored, record);
      return record;
    }),
    findOne: vi.fn(async ({ where }: { where: Partial<TwoFactorSecret> }) => {
      const seeded = options.record;
      // Only the first call is seeded. Every later read returns whatever the last
      // write left, which is what makes a test that writes then reads meaningful
      // rather than a test of a fixture.
      if (seeded && Object.keys(stored).length === 0) {
        return buildRecord(seeded);
      }

      if (Object.keys(stored).length > 0) {
        return stored as unknown as TwoFactorSecret;
      }

      return where.userId ? null : null;
    }),
    delete: vi.fn(async () => undefined),
  };

  const jwtService = {
    sign: vi.fn((payload: object) =>
      Buffer.from(JSON.stringify(payload)).toString('base64url'),
    ),
    decode: vi.fn(() => ({ iat: 1_000, exp: 1_060 })),
    verify: vi.fn((token: string) => {
      const payload = JSON.parse(
        Buffer.from(token, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;

      if (payload.type !== 'two_factor_challenge') {
        throw new Error('not a challenge');
      }

      return payload;
    }),
  };

  const service = new TwoFactorService(
    repository as never,
    {
      getOrThrow: (key: string) => {
        if (key === 'twoFactor') {
          return { enabled, issuer: ISSUER, encryptionKey: ENCRYPTION_KEY };
        }
        return { secret: 'access-token-secret' };
      },
    } as never,
    jwtService as never,
  );

  return { service, repository, jwtService, stored };
}

function buildRecord(partial: Partial<TwoFactorSecret>): TwoFactorSecret {
  const key = deriveKey(ENCRYPTION_KEY);
  const encrypted = encrypt(BASE32, key);

  return {
    id: 'row-1',
    userId: ACCOUNT,
    secretCiphertext: encrypted.ciphertext,
    secretIv: encrypted.iv,
    secretAuthTag: encrypted.authTag,
    recoveryCodes: [],
    isEnabled: true,
    enabledAt: new Date(),
    lastUsedAt: null,
    lastUsedCounter: null,
    failedAttempts: 0,
    lockedUntil: null,
    ...partial,
  } as TwoFactorSecret;
}

/** A code that the authenticator app would be showing right now. */
function currentCode(base32 = BASE32): string {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label: ACCOUNT,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
    secret: OTPAuth.Secret.fromBase32(base32),
  }).generate();
}

describe('when two-factor is switched off', () => {
  it('reports the account as not enabled without touching the database', async () => {
    const h = harness({ enabled: false });

    await expect(h.service.isEnabled(ACCOUNT)).resolves.toBe(false);
    expect(h.repository.findOne).not.toHaveBeenCalled();
  });

  it('refuses to set it up, rather than storing a secret nothing will use', async () => {
    const h = harness({ enabled: false });

    await expect(h.service.setup(ACCOUNT, ACCOUNT)).rejects.toThrow(
      NotFoundException,
    );
    expect(h.repository.save).not.toHaveBeenCalled();
  });
});

describe('setting two-factor up', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  it('stores the secret encrypted, never in the clear', async () => {
    const setup = await h.service.setup(ACCOUNT, ACCOUNT);

    const saved = h.repository.save.mock.calls[0][0];

    expect(saved.secretCiphertext).not.toContain(BASE32);
    expect(setup.secret).toBe(
      decrypt(
        {
          ciphertext: saved.secretCiphertext,
          iv: saved.secretIv,
          authTag: saved.secretAuthTag,
        },
        deriveKey(ENCRYPTION_KEY),
      ),
    );
  });

  it('leaves the factor inactive until a code confirms it', async () => {
    await h.service.setup(ACCOUNT, ACCOUNT);

    // An unconfirmed secret that `isEnabled` reported as active would lock an
    // account out of its own second factor.
    expect(h.repository.save.mock.calls[0][0].isEnabled).toBe(false);
  });

  it('offers a scannable enrolment url and a qr code', async () => {
    const setup = await h.service.setup(ACCOUNT, ACCOUNT);

    expect(setup.otpauthUrl).toContain('otpauth://');
    expect(setup.otpauthUrl).toContain(ISSUER);
    expect(setup.qrCode).toMatch(/^data:image\/png;base64,/);
  });
});

describe('verifying a challenge', () => {
  it('accepts a current code', async () => {
    const h = harness({ record: {} });

    await expect(
      h.service.verifyChallenge(ACCOUNT, currentCode()),
    ).resolves.toBeUndefined();
  });

  it('refuses the same code twice', async () => {
    const h = harness({ record: {} });
    const code = currentCode();

    await h.service.verifyChallenge(ACCOUNT, code);

    // A TOTP code is valid for a window of steps. Without the counter, an
    // attacker who shoulder-surfs one code has thirty seconds of unlimited use.
    await expect(h.service.verifyChallenge(ACCOUNT, code)).rejects.toThrow(
      'already used',
    );
  });

  it('records the counter it accepted, not the time', async () => {
    const h = harness({ record: {} });

    await h.service.verifyChallenge(ACCOUNT, currentCode());

    expect(h.repository.save.mock.calls[0][0].lastUsedCounter).not.toBeNull();
    expect(h.repository.save.mock.calls[0][0].lastUsedAt).toBeInstanceOf(Date);
  });

  it('locks the factor after repeated failures', async () => {
    const h = harness({ record: {} });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        h.service.verifyChallenge(ACCOUNT, '000000'),
      ).rejects.toThrow();
    }

    // The next attempt is refused before the code is even looked at, so the lock
    // cannot be worked around by guessing faster.
    await expect(
      h.service.verifyChallenge(ACCOUNT, currentCode()),
    ).rejects.toThrow('try again later');
  });

  it('refuses an account whose factor was never set up', async () => {
    const h = harness({ record: null });

    await expect(h.service.verifyChallenge(ACCOUNT, '123456')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('refuses an account whose factor is not active', async () => {
    const h = harness({ record: { isEnabled: false } });

    await expect(h.service.verifyChallenge(ACCOUNT, '123456')).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('confirming a setup', () => {
  it('activates the factor and issues recovery codes', async () => {
    const h = harness({ record: { isEnabled: false } });

    const { recoveryCodes } = await h.service.verifySetup(
      ACCOUNT,
      currentCode(),
    );

    expect(recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(h.repository.save.mock.calls[0][0].isEnabled).toBe(true);
  });

  it('stores the recovery codes hashed, and shows the plain ones once', async () => {
    const h = harness({ record: { isEnabled: false } });

    const { recoveryCodes } = await h.service.verifySetup(
      ACCOUNT,
      currentCode(),
    );

    const stored = h.repository.save.mock.calls[0][0].recoveryCodes as string[];

    expect(stored).not.toEqual(expect.arrayContaining(recoveryCodes));
    // The plain list is returned exactly once and never written down, which is
    // the only reason a lost phone is recoverable at all.
    expect(JSON.stringify(stored)).not.toContain(recoveryCodes[0]);
  });

  it('refuses a code from an authenticator that is out of step', async () => {
    const h = harness({ record: { isEnabled: false } });

    await expect(h.service.verifySetup(ACCOUNT, '000000')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(h.repository.save).not.toHaveBeenCalled();
  });

  it('refuses to confirm a factor that is already active', async () => {
    const h = harness({ record: { isEnabled: true } });

    await expect(h.service.verifySetup(ACCOUNT, currentCode())).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('turning two-factor off', () => {
  it('deletes the record when a current code is given', async () => {
    const h = harness({ record: {} });

    await h.service.disable(ACCOUNT, currentCode());

    expect(h.repository.delete).toHaveBeenCalledWith({ id: 'row-1' });
  });

  it('deletes the record when a recovery code is given', async () => {
    const { service, repository, stored } = await setupWithRecoveryCode();
    void stored;

    await service.disable(ACCOUNT, PLAIN_RECOVERY_CODE);

    expect(repository.delete).toHaveBeenCalledWith({ id: 'row-1' });
  });

  it('keeps the record when the code is wrong', async () => {
    const h = harness({ record: {} });

    await expect(h.service.disable(ACCOUNT, '000000')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(h.repository.delete).not.toHaveBeenCalled();
  });
});

const PLAIN_RECOVERY_CODE = 'recovery-code-0';

/** A harness whose record carries one usable recovery code. */
async function setupWithRecoveryCode() {
  const { generateRecoveryCodes, hashRecoveryCode } =
    await import('../../common/utils/index.js');

  const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  // Awaited: the digest is scrypt now, so the harness has to pay the same cost
  // the service does rather than storing a promise where a string belongs.
  const hash = await hashRecoveryCode(PLAIN_RECOVERY_CODE);
  const hashed = await Promise.all(codes.map((code) => hashRecoveryCode(code)));

  return harness({
    record: { recoveryCodes: [...hashed, hash] },
  });
}

describe('the challenge token', () => {
  it('names the account and carries no permission', () => {
    const h = harness();
    const challenge = h.service.issueChallenge(ACCOUNT);

    expect(h.jwtService.sign.mock.calls[0][0]).toMatchObject({
      sub: ACCOUNT,
      type: 'two_factor_challenge',
    });
    expect(challenge.twoFactorRequired).toBe(true);
    expect(challenge.expiresIn).toBe(60);
  });

  it('hands back the account it names', () => {
    const h = harness();

    expect(
      h.service.verifyChallengeToken(
        h.service.issueChallenge(ACCOUNT).challengeToken,
      ),
    ).toBe(ACCOUNT);
  });

  it('refuses a token that is some other kind of jwt', () => {
    const h = harness();

    // An access token is a valid signature over a valid payload. Accepting one
    // here would let a client skip the second factor by replaying its own access
    // token as a challenge.
    const accessToken = Buffer.from(
      JSON.stringify({ sub: ACCOUNT, type: 'access' }),
    ).toString('base64url');

    expect(() => h.service.verifyChallengeToken(accessToken)).toThrow(
      UnauthorizedException,
    );
  });

  it('refuses a token naming no account', () => {
    const h = harness();
    const token = Buffer.from(
      JSON.stringify({ type: 'two_factor_challenge' }),
    ).toString('base64url');

    expect(() => h.service.verifyChallengeToken(token)).toThrow(
      UnauthorizedException,
    );
  });
});
