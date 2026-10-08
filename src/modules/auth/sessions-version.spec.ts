import { JwtService } from '@nestjs/jwt';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserResponseDto } from '../users/dto/index.js';
import { User } from '../users/entities/index.js';
import { Role } from '../../common/enums/index.js';
import { AuthService } from './auth.service.js';

/**
 * The claim and the bump are the two halves of `sessionsVersion`, and a test that
 * only covers the comparison in `JwtStrategy` proves neither.
 *
 * Removing `sv` from the signed token, or removing either increment, leaves every
 * assertion about the comparison passing while the feature silently does nothing:
 * a token minted without the claim is accepted while the user sits at version
 * zero, which is exactly the state nobody notices.
 */

const SECRET = 'test-secret'.repeat(4);

function userDto(overrides: Partial<UserResponseDto> = {}): UserResponseDto {
  return {
    id: 'u1',
    email: 'a@x.com',
    role: 'user',
    isManager: false,
    isActive: true,
    sessionsVersion: 0,
    ...overrides,
  } as UserResponseDto;
}

/**
 * The machine the token was minted on. Present because the payload now names it,
 * which is what lets one device sign out without taking the others.
 */
const DEVICE = { id: 'd1', sessionsVersion: 0 };

function harness() {
  const increment = vi.fn().mockResolvedValue({ affected: 1 });
  const manager = {
    increment,
    save: vi.fn(),
    update: vi.fn().mockResolvedValue({ affected: 1 }),
  };

  const revokeAllByUserId = vi.fn().mockResolvedValue(1);
  const refreshTokenService = {
    revokeAllByUserId,
    runInTransaction: vi.fn(async (handler: (m: unknown) => Promise<unknown>) =>
      handler(manager),
    ),
  };

  const invalidateAuthCache = vi.fn().mockResolvedValue(undefined);

  // Mirrors the real helper: run the work, then drop the cached claims. The work
  // has to actually run here, or these tests would pass on an empty transaction.
  const usersService = {
    invalidateAuthCache,
    runThenInvalidateAuthCache: vi.fn(
      async (userId: string, work: () => Promise<unknown>) => {
        try {
          return await work();
        } finally {
          await invalidateAuthCache(userId);
        }
      },
    ),
  };

  const service = new AuthService(
    new JwtService({ secret: SECRET, signOptions: { expiresIn: '15m' } }),
    usersService as never,
    refreshTokenService as never,
    { revokeAllByUserId: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { enqueue: vi.fn() } as never,
    { getOrThrow: vi.fn().mockReturnValue({}) } as never,
    {
      // The lockout counts failures in redis, which these tests do not stand up.
      // Reporting no block keeps each test testing what it was written for.
      inspect: vi.fn().mockResolvedValue({
        blocked: false,
        retryAfterSeconds: 0,
        firstBlock: false,
      }),
      recordFailure: vi.fn().mockResolvedValue({
        blocked: false,
        retryAfterSeconds: 0,
        firstBlock: false,
      }),
      reset: vi.fn().mockResolvedValue(undefined),
    } as never,
  );

  return {
    service,
    increment,
    manager,
    revokeAllByUserId,
    invalidateAuthCache,
  };
}

describe('the access token claim', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  /** Signs through the real service, so the payload cannot drift from the claim. */
  async function signedToken(
    dto: UserResponseDto,
  ): Promise<Record<string, unknown>> {
    const jwt = new JwtService({ secret: SECRET });

    return jwt.decode(
      // Reaching the private signer on purpose: the public paths all need a
      // password hash and a token row, and what is under test is the payload.
      await (
        h.service as unknown as {
          signAccessToken(
            u: UserResponseDto,
            d: { id: string; sessionsVersion: number },
          ): Promise<string>;
        }
      ).signAccessToken(dto, DEVICE),
    ) as Record<string, unknown>;
  }

  it('carries the version the user currently has', async () => {
    expect((await signedToken(userDto({ sessionsVersion: 3 }))).sv).toBe(3);
  });

  it('is zero for a user who has never revoked', async () => {
    expect((await signedToken(userDto())).sv).toBe(0);
  });

  it('matches the row the token was minted from', async () => {
    // The strategy compares this against the column, so a value taken from
    // anywhere else is a value that can disagree with it.
    expect((await signedToken(userDto({ sessionsVersion: 7 }))).sv).toBe(7);
  });

  it('still carries the identity claims the strategy needs', async () => {
    const claims = await signedToken(
      userDto({ role: Role.Admin, isManager: true }),
    );

    expect(claims.sub).toBe('u1');
    expect(claims.role).toBe('admin');
    expect(claims.isManager).toBe(true);
  });
});

describe('logout everywhere', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  const currentUser = { id: 'u1', permissions: [] } as never;

  it('bumps the version', async () => {
    await h.service.logoutAll(currentUser);

    // Without this the refresh tokens die but every access token keeps working
    // for its fifteen minutes, so the account looks revoked and is not.
    expect(h.increment).toHaveBeenCalledWith(
      User,
      { id: 'u1' },
      'sessionsVersion',
      1,
    );
  });

  it('increments rather than setting a fixed value', async () => {
    await h.service.logoutAll(currentUser);

    // A constant would let a token minted between two logouts look current again.
    const [entity, criteria, property, amount] = h.increment.mock.calls[0];

    expect(property).toBe('sessionsVersion');
    expect(amount).toBe(1);
    expect(entity).toBe(User);
    expect(criteria).toEqual({ id: 'u1' });
  });

  it('bumps inside the transaction, so a crash cannot half-apply it', async () => {
    await h.service.logoutAll(currentUser);

    // A version committed separately from the revocation would leave every token
    // valid against a row that says the sessions were killed.
    expect(h.revokeAllByUserId).toHaveBeenCalled();
    expect(h.increment).toHaveBeenCalled();
  });

  it('still revokes every refresh token', async () => {
    await h.service.logoutAll(currentUser);

    expect(h.revokeAllByUserId).toHaveBeenCalledTimes(1);
  });

  it('refuses an unauthenticated caller without bumping anything', async () => {
    await expect(
      h.service.logoutAll({ id: undefined } as never),
    ).rejects.toThrow();

    expect(h.increment).not.toHaveBeenCalled();
  });
});
