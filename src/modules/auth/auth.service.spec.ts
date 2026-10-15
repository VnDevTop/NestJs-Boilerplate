import { UnauthorizedException } from '@nestjs/common';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.service.js';

/**
 * Sign-in and sign-up, as units.
 *
 * The rest of the auth module is covered by specs that each own one decision —
 * rotation, lockout, reset, enumeration, verification. What is left uncovered is
 * `AuthService` itself, and it is where the ordering lives: the block is read
 * before the account is, a failure is counted for an address that does not
 * exist, the password policy runs before the hash, and the verification mail is
 * never awaited.
 *
 * Every one of those is invisible to a test that only checks the response, and
 * every one of them is an enumeration or an availability bug if it inverts.
 */

const USER = {
  id: 'u1',
  email: 'a@x.com',
  // A real hash of `Correct-horse-1`, so the happy path verifies rather than
  // being short-circuited by a fake.
  password: '',
  firstName: 'Ada',
  lastName: null,
  role: 'user',
  isActive: true,
  isManager: false,
  sessionsVersion: 0,
  isEmailVerified: true,
  emailVerifiedAt: new Date(),
  lastLoginAt: null,
  lockedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
} as never;

const metadata = {
  ipAddress: '1.1.1.1',
  userAgent: 'vitest',
  deviceName: null,
};

const DEVICE = { id: 'd1', userId: 'u1', sessionsVersion: 0 };

type Overrides = {
  user?: unknown;
  blocked?: boolean;
  policyOk?: boolean;
};

async function harness(options: Overrides = {}) {
  const { user = USER, blocked = false, policyOk = true } = options;

  const { hashPassword } = await import('../../common/utils/index.js');
  // Hashed once for the whole harness rather than stubbed: `verifyPassword` is
  // real, and a stubbed comparator would make a login test that cannot tell a
  // wrong password from a right one.
  const storedHash =
    user && (user as { password?: string }).password
      ? (user as { password: string }).password
      : await hashPassword('Correct-horse-1');

  // The stored hash is what the account lookup returns, not the fixture's empty
  // placeholder. A fixture whose `password` field was a blank string would make
  // every "correct password" assertion here a test of a comparator against
  // nothing.
  const account = user ? { ...(user as object), password: storedHash } : null;

  const usersService = {
    findByEmail: vi.fn().mockResolvedValue(account),
    findById: vi.fn().mockResolvedValue(account),
    create: vi.fn().mockResolvedValue(account),
  };

  const loginLockout = {
    inspect: vi.fn().mockResolvedValue({
      blocked,
      retryAfterSeconds: blocked ? 60 : 0,
      firstBlock: blocked,
      failures: blocked ? 5 : 1,
    }),
    recordFailure: vi.fn().mockResolvedValue({
      blocked,
      retryAfterSeconds: 60,
      firstBlock: blocked,
      failures: 5,
    }),
    reset: vi.fn().mockResolvedValue(undefined),
  };

  const notifications = {
    notify: vi.fn(async () => ({ notificationId: 'n1', queued: true })),
  };

  const jobQueue = {
    enqueue: vi.fn(async () => undefined),
  };

  const passwordPolicy = {
    check: vi.fn(async () => ({
      ok: policyOk,
      reasons: policyOk ? [] : ['Password is too common'],
    })),
  };

  const metrics = { loginAttempt: vi.fn() };

  const service = new AuthService(
    {
      signAsync: vi.fn().mockResolvedValue('access-token'),
      decode: vi.fn().mockReturnValue({ iat: 1, exp: 1_900 }),
    } as never,
    usersService as never,
    {
      issue: vi.fn().mockResolvedValue({
        token: 'refresh-token',
        record: { jti: 'jti-1' },
      }),
      runInTransaction: vi.fn(),
    } as never,
    {
      register: vi.fn().mockResolvedValue({ device: DEVICE, created: true }),
    } as never,
    { isEnabled: vi.fn().mockResolvedValue(false) } as never,
    { consume: vi.fn() } as never,
    { spendOutstandingFor: vi.fn() } as never,
    {
      // Registration builds its verification url through the mail service, which
      // owns `APP_URL`. A stub here would hide a wrong base url.
      buildUrl: (path: string) => `http://localhost:3000${path}`,
    } as never,
    jobQueue as never,
    { getOrThrow: () => ({ name: 'Example', env: 'test' }) } as never,
    loginLockout as never,
    notifications as never,
    passwordPolicy as never,
    { record: vi.fn(), wasUsedBefore: vi.fn(async () => false) } as never,
    { lockOnRepeatedFailures: vi.fn(async () => undefined) } as never,
    // The session ceiling, off. Nothing in this file is about session age, and a
    // collaborator that only exists to enforce a policy should not impose one
    // because a test forgot to say.
    { absoluteTtlSeconds: 0 } as never,
    // The metric counter. A spy rather than the real one, so a test can assert the
    // pair of counters that make a failure rate meaningful. It is the last
    // constructor argument, and its default only applies when the argument is
    // `undefined`, so it has to be passed explicitly — which is also why the
    // argument before it can no longer be skipped.
    metrics as never,
  );

  return {
    service,
    usersService,
    loginLockout,
    notifications,
    jobQueue,
    passwordPolicy,
    metrics,
    storedHash,
  };
}

describe('AuthService.login', () => {
  let h: Awaited<ReturnType<typeof harness>>;

  beforeEach(async () => {
    h = await harness();
  });

  it('checks the block before it looks the account up', async () => {
    const blocked = await harness({ blocked: true });

    await expect(
      blocked.service.login(
        { email: 'a@x.com', password: 'x' } as never,
        metadata as never,
      ),
    ).rejects.toThrow();

    // The order is the whole defence. Looking the account up first and blocking
    // afterwards would make a blocked address measurably slower than an unblocked
    // one, which is the timing oracle `enumeration.spec.ts` closes.
    expect(blocked.usersService.findByEmail).not.toHaveBeenCalled();
  });

  it('counts a failure for an address that does not exist', async () => {
    const missing = await harness({ user: null });

    await expect(
      missing.service.login(
        { email: 'nobody@x.com', password: 'x' } as never,
        metadata as never,
      ),
    ).rejects.toThrow(UnauthorizedException);

    // Counting only real accounts would make the answer to a burst of attempts
    // reveal which addresses are registered, with no successful guess anywhere.
    expect(missing.loginLockout.recordFailure).toHaveBeenCalledWith(
      'nobody@x.com',
    );
  });

  it('answers a permanently locked account exactly as an unregistered one', async () => {
    const locked = await harness({
      user: { ...(USER as object), lockedAt: new Date() },
    });
    const missing = await harness({ user: null });

    const lockedMessage = await messageOf(
      locked.service.login(
        { email: 'a@x.com', password: 'x' } as never,
        metadata as never,
      ),
    );
    const missingMessage = await messageOf(
      missing.service.login(
        { email: 'a@x.com', password: 'x' } as never,
        metadata as never,
      ),
    );

    expect(lockedMessage).toBe(missingMessage);
  });

  it('counts a rejected attempt in the metric a failure rate is built from', async () => {
    // The only sign-in signal that survives a redis outage, because the rate
    // limiter and the lockout both fail open.
    await expect(
      h.service.login(
        { email: 'a@x.com', password: 'wrong' } as never,
        metadata as never,
      ),
    ).rejects.toThrow();

    expect(h.metrics.loginAttempt).toHaveBeenCalledWith('failure');
  });

  it('records a failure for a wrong password and answers the same way', async () => {
    await expect(
      h.service.login(
        { email: 'a@x.com', password: 'wrong' } as never,
        metadata as never,
      ),
    ).rejects.toThrow('Invalid email or password');

    expect(h.loginLockout.recordFailure).toHaveBeenCalledWith('a@x.com');
  });

  it('clears the failure count and counts the success on a good password', async () => {
    const good = await harness();

    await good.service.login(
      { email: 'a@x.com', password: 'Correct-horse-1' } as never,
      metadata as never,
    );

    // Reset before anything else can fail, so a transient error later in the
    // sign-in cannot leave a count that blocks the next honest attempt.
    expect(good.loginLockout.reset).toHaveBeenCalledWith('a@x.com');
    expect(good.loginLockout.recordFailure).not.toHaveBeenCalled();
    expect(good.metrics.loginAttempt).toHaveBeenCalledWith('success');
  });

  it('does not mail the owner about every rejected attempt', async () => {
    // One mail per block, not one per request. Per request would turn the login
    // route into a way to make the application mail an address repeatedly.
    const h2 = await harness({ blocked: true });

    await expect(
      h2.service.login(
        { email: 'a@x.com', password: 'x' } as never,
        metadata as never,
      ),
    ).rejects.toThrow();

    expect(h2.jobQueue.enqueue).not.toHaveBeenCalled();
  });
});

describe('AuthService.register', () => {
  let h: Awaited<ReturnType<typeof harness>>;

  beforeEach(async () => {
    h = await harness();
  });

  const dto = {
    email: 'new@x.com',
    password: 'Correct-horse-1',
    firstName: 'New',
    lastName: null,
  };

  it('refuses a rejected password before it creates anything', async () => {
    const refused = await harness({ policyOk: false });

    await expect(
      refused.service.register(dto as never, metadata as never),
    ).rejects.toThrow();

    // Before the user row, not after. Hashing is deliberately slow, and a signup
    // that reaches the database before refusing a password has already charged
    // somebody scrypt for the privilege of being told no.
    expect(refused.usersService.create).not.toHaveBeenCalled();
  });

  it('queues the verification mail instead of awaiting it', async () => {
    const slow = await harness();
    slow.jobQueue.enqueue.mockImplementation(() => {
      throw new Error('queue is down');
    });

    // The registration resolves. A provider or queue outage is an operational
    // problem, and turning it into a 500 here would fail signups for everybody
    // because a background worker was down.
    await expect(
      slow.service.register(dto as never, metadata as never),
    ).resolves.toMatchObject({ tokenType: 'Bearer' });
  });

  it('returns a token pair carrying the user', async () => {
    const result = await h.service.register(dto as never, metadata as never);

    expect(result).toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tokenType: 'Bearer',
    });
    expect(result.user.email).toBe('a@x.com');
  });
});

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '<resolved>';
  } catch (error) {
    return (error as Error).message;
  }
}
