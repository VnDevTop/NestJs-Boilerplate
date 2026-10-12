import { describe, expect, it, vi } from 'vitest';

import { UnauthorizedException } from '@nestjs/common';

import { AuthService } from './auth.service.js';

/**
 * A permanently locked account has to be indistinguishable from an address nobody
 * registered.
 *
 * This is a separate file rather than more cases in `enumeration.spec.ts` because
 * that file measures timing on the forgot-password route, and the claim here is
 * different in kind: not "takes about as long" but "says the same thing". A locked
 * account that answers with a dedicated "this account is locked" status or message
 * is a free oracle for anybody willing to burn twenty attempts on an address, which
 * is the price of the feature.
 *
 * Every expectation below is the same one a caller with no account at all would
 * see.
 */

const PASSWORD = 'correct horse battery staple';

function harness(
  options: { locked?: boolean; active?: boolean; exists?: boolean } = {},
) {
  const user =
    options.exists === false
      ? null
      : {
          id: 'u1',
          email: 'a@x.com',
          password: '$scrypt$placeholder',
          isActive: options.active ?? true,
          isEmailVerified: true,
          lockedAt: options.locked ? new Date('2026-03-01T00:00:00Z') : null,
        };

  const lockout = {
    inspect: vi.fn().mockResolvedValue({
      blocked: false,
      retryAfterSeconds: 0,
      firstBlock: false,
      failures: 0,
    }),
    recordFailure: vi.fn().mockResolvedValue({
      blocked: false,
      retryAfterSeconds: 0,
      firstBlock: false,
      failures: 1,
    }),
    reset: vi.fn().mockResolvedValue(undefined),
  };

  const notifications = {
    notify: vi.fn(async () => ({ notificationId: 'n1', queued: true })),
  };

  // Just enough of each collaborator to reach the account check. The lock is
  // refused before any of them is used, so a fake that throws when called would
  // also pass these tests — which is the point: they are asserting that the account
  // check happens first, not that the route works.
  // `verify` runs before the account is read — it has to, because the account id
  // comes out of the token. So this one is a real answer rather than a trap, and
  // the assertion below is about what happens to a *valid* token for a locked
  // account, which is the case that matters.
  const refreshTokenService = {
    verify: vi.fn(() => ({ sub: 'u1', jti: 'j1' })),
  };

  const twoFactorService = {
    verifyChallengeToken: vi.fn(() => 'u1'),
  };

  const service = new AuthService(
    {} as never,
    {
      findByEmail: vi.fn(async () => user),
      findById: vi.fn(async () => user),
    } as never,
    refreshTokenService as never,
    {} as never,
    twoFactorService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    lockout as never,
    notifications as never,
    { check: vi.fn(async () => ({ ok: true, reasons: [] })) } as never,
    {} as never,
    { lockOnRepeatedFailures: vi.fn(async () => undefined) } as never,
  );

  return { service, user, lockout, notifications };
}

const metadata = { deviceName: null, ipAddress: null, userAgent: null };

describe('a locked account signing in', () => {
  it('answers exactly as an address with no account does', async () => {
    const locked = harness({ locked: true });
    const missing = harness({ exists: false });

    const lockedError = await locked.service
      .login({ email: 'a@x.com', password: 'wrong' }, metadata)
      .then(() => null)
      .catch((error: unknown) => error);

    const missingError = await missing.service
      .login({ email: 'a@x.com', password: 'wrong' }, metadata)
      .then(() => null)
      .catch((error: unknown) => error);

    expect(lockedError).toBeInstanceOf(UnauthorizedException);
    expect((lockedError as UnauthorizedException).message).toBe(
      'Invalid email or password',
    );
    expect((lockedError as UnauthorizedException).message).toBe(
      (missingError as UnauthorizedException).message,
    );
    expect((lockedError as UnauthorizedException).getStatus()).toBe(
      (missingError as UnauthorizedException).getStatus(),
    );
  });

  it('does not verify the password, so a locked account cannot be probed', async () => {
    // The branch sits before the hash check. A scrypt verification per attempt would
    // both cost the attacker nothing and tell them, through the timing, whether they
    // were getting warmer — against an account they are already locked out of.
    const h = harness({ locked: true });

    await expect(
      h.service.login({ email: 'a@x.com', password: PASSWORD }, metadata),
    ).rejects.toThrow('Invalid email or password');
  });

  it('still counts the attempt, so the temporary limits stay switched on', async () => {
    // Switching them off for a locked account would let an attacker hammer a locked
    // account without limit, on the theory that there is nothing left to protect.
    const h = harness({ locked: true });

    await h.service
      .login({ email: 'a@x.com', password: 'wrong' }, metadata)
      .catch(() => undefined);

    expect(h.lockout.recordFailure).toHaveBeenCalledWith('a@x.com');
  });

  it('does not hand out a session, which is the only part that matters', async () => {
    const h = harness({ locked: true });

    await expect(
      h.service.login({ email: 'a@x.com', password: 'wrong' }, metadata),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('is refused the refresh route too', async () => {
    // Otherwise the lock is undone by any client that reacts to a 401 by
    // refreshing: the strategy would refuse the new token, and the client would
    // refresh again, forever, holding a working refresh chain the whole time.
    const h = harness({ locked: true });

    await expect(
      h.service.refresh({ refreshToken: 'r' }, metadata),
    ).rejects.toThrow('Invalid refresh token');
  });

  it('is refused the two-factor route too', async () => {
    // Finishing a second-factor sign-in is another way in, and the challenge token
    // is a credential in its own right.
    const h = harness({ locked: true });

    await expect(
      h.service.twoFactorLogin(
        { challengeToken: 'c', code: '000000' },
        metadata,
      ),
    ).rejects.toThrow('Invalid two-factor challenge');
  });
});

describe('a locked account and an active one', () => {
  it('are refused by the same comparison, so there is one rule to reason about', async () => {
    // `!user.isActive` and `user.lockedAt !== null` are the same branch. A second
    // check with its own message would be the place an enumeration oracle grows.
    const locked = harness({ locked: true });
    const inactive = harness({ active: false });

    const lockedError = await locked.service
      .login({ email: 'a@x.com', password: 'wrong' }, metadata)
      .catch((error: unknown) => error as UnauthorizedException);

    const inactiveError = await inactive.service
      .login({ email: 'a@x.com', password: 'wrong' }, metadata)
      .catch((error: unknown) => error as UnauthorizedException);

    expect((lockedError as UnauthorizedException).message).toBe(
      (inactiveError as UnauthorizedException).message,
    );
  });
});
