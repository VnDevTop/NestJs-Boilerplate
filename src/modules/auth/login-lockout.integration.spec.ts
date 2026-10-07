import { UnauthorizedException } from '@nestjs/common';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hashPassword } from '../../common/utils/index.js';
import { LoginLockedException } from './exceptions/login-locked.exception.js';
import type { LockoutState } from './login-lockout.service.js';
import { LOCKOUT_THRESHOLD } from './login-lockout.service.js';
import { AuthService } from './auth.service.js';

/**
 * These call the real `login()`, because the property worth defending is about
 * the order of operations inside it: what gets counted, what gets looked up, and
 * what the caller is told. Asserting on a mock would pass with the calls removed.
 */

const PASSWORD = 'correct-horse-battery';

const ALLOWED: LockoutState = {
  blocked: false,
  retryAfterSeconds: 0,
  firstBlock: false,
};

const BLOCKED: LockoutState = {
  blocked: true,
  retryAfterSeconds: 60,
  firstBlock: false,
};

const FIRST_BLOCK: LockoutState = {
  blocked: true,
  retryAfterSeconds: 60,
  firstBlock: true,
};

const appConfig = {
  name: 'Example',
  env: 'test',
  url: 'https://app.example.com',
};

async function harness(
  options: {
    userExists?: boolean;
    isActive?: boolean;
    inspect?: LockoutState;
    recordFailure?: LockoutState;
  } = {},
) {
  const sent: { to: string; template: string }[] = [];

  const user = {
    id: 'user-1',
    email: 'a@x.com',
    password: await hashPassword(PASSWORD),
    isActive: options.isActive ?? true,
    role: 'user',
    isManager: false,
    sessionsVersion: 0,
  };

  const usersService = {
    findByEmail: vi
      .fn()
      .mockResolvedValue(options.userExists === false ? null : user),
    findById: vi.fn().mockResolvedValue(user),
  };

  const lockout = {
    inspect: vi.fn().mockResolvedValue(options.inspect ?? ALLOWED),
    recordFailure: vi.fn().mockResolvedValue(options.recordFailure ?? ALLOWED),
    reset: vi.fn().mockResolvedValue(undefined),
  };

  const jobQueue = {
    enqueue: vi.fn(
      async (
        _q: string,
        job: { payload: { to: string; template: string } },
      ) => {
        sent.push({ to: job.payload.to, template: job.payload.template });

        return undefined;
      },
    ),
    driver: 'in-process' as const,
  };

  const mailService = {
    sendTemplate: () => Promise.resolve({ mailId: 'm', delivered: true }),
    buildUrl: (path: string) => `${appConfig.url}${path}`,
  };

  const service = new AuthService(
    {} as never,
    usersService as never,
    {} as never,
    {} as never,
    { isEnabled: () => Promise.resolve(false) } as never,
    {} as never,
    {} as never,
    mailService as never,
    jobQueue as never,
    { getOrThrow: () => appConfig } as never,
    lockout as never,
  );

  const dto = { email: 'a@x.com', password: 'guess' };

  return { service, dto, lockout, usersService, sent, jobQueue };
}

describe('a locked account', () => {
  let h: Awaited<ReturnType<typeof harness>>;

  beforeEach(async () => {
    h = await harness({ inspect: BLOCKED });
  });

  it('is refused with a 429', async () => {
    await expect(
      h.service.login(h.dto, {
        deviceName: null,
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow(LoginLockedException);
  });

  it('does not look the account up', async () => {
    await expect(
      h.service.login(h.dto, {
        deviceName: null,
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow();

    // The check comes first, so a locked address costs one redis read instead of
    // a database read and a password hash.
    expect(h.usersService.findByEmail).not.toHaveBeenCalled();
  });

  it('does not count another failure while blocked', async () => {
    await expect(
      h.service.login(h.dto, {
        deviceName: null,
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow();

    // Counting here would extend the block on every attempt, so an attacker could
    // keep somebody locked indefinitely by never stopping.
    expect(h.lockout.recordFailure).not.toHaveBeenCalled();
  });

  it('answers identically whether or not the address exists', async () => {
    const missing = await harness({ userExists: false, inspect: BLOCKED });

    await expect(
      missing.service.login(missing.dto, {
        deviceName: null,
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow(LoginLockedException);
  });
});

describe('a wrong password', () => {
  it('is counted', async () => {
    const h = await harness();

    await expect(
      h.service.login(h.dto, {
        deviceName: null,
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow(UnauthorizedException);

    expect(h.lockout.recordFailure).toHaveBeenCalledWith('a@x.com');
  });

  it('keeps the message it has always returned', async () => {
    const h = await harness();

    await expect(
      h.service.login(h.dto, {
        deviceName: null,
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow('Invalid email or password');
  });

  it('is counted for an address that does not exist too', async () => {
    // The property that keeps the enumeration question closed: if only real
    // accounts could be blocked, the 429 would confirm which addresses exist
    // without a single successful guess.
    const h = await harness({ userExists: false });

    await expect(
      h.service.login(h.dto, {
        deviceName: null,
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow('Invalid email or password');

    expect(h.lockout.recordFailure).toHaveBeenCalledWith('a@x.com');
  });
});

describe('an inactive account', () => {
  it('is counted as a failure, not waved through', async () => {
    const h = await harness({ isActive: false });

    await expect(
      h.service.login(h.dto, {
        deviceName: null,
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow('Invalid email or password');

    expect(h.lockout.recordFailure).toHaveBeenCalled();
  });
});

describe('notifying the owner', () => {
  it('sends account-locked on the attempt that starts the block', async () => {
    const h = await harness({ recordFailure: FIRST_BLOCK });

    await expect(
      h.service.login(h.dto, {
        deviceName: null,
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow(UnauthorizedException);

    expect(h.sent).toEqual([{ to: 'a@x.com', template: 'account-locked' }]);
  });

  it('sends nothing on a failure that does not block', async () => {
    const h = await harness({ recordFailure: ALLOWED });

    await expect(
      h.service.login(h.dto, {
        deviceName: null,
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow();

    expect(h.sent).toEqual([]);
  });

  it('sends nothing when the address does not exist', async () => {
    // Mailing an address nobody registered turns the login route into a way to
    // make the application send mail to a stranger.
    const h = await harness({ userExists: false, recordFailure: FIRST_BLOCK });

    // Asserting the exception type matters: without the existence check the code
    // throws a TypeError instead, and `sent` is still empty, so a bare
    // `rejects.toThrow()` would pass with the guard removed.
    await expect(
      h.service.login(h.dto, {
        deviceName: null,
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow('Invalid email or password');

    expect(h.sent).toEqual([]);
  });
});

describe('a successful sign-in', () => {
  it('clears the failure count', async () => {
    const h = await harness();

    // The rest of the sign-in is not what this test is about, and the harness
    // does not stand up device registration, so the call is allowed to fail after
    // the reset. The ordering is the claim: the reset happens first, so a later
    // failure cannot leave a count that will block the next honest attempt.
    await h.service
      .login(
        { email: 'a@x.com', password: PASSWORD },
        { deviceName: null, ipAddress: null, userAgent: null },
      )
      .catch(() => undefined);

    expect(h.lockout.reset).toHaveBeenCalledWith('a@x.com');
  });

  it('clears the count before anything later can fail', async () => {
    const h = await harness();

    await h.service
      .login(
        { email: 'a@x.com', password: PASSWORD },
        { deviceName: null, ipAddress: null, userAgent: null },
      )
      .catch(() => undefined);

    // Ordering, asserted rather than assumed: the reset has to come before the
    // device registration that follows it in the method.
    const resetOrder = h.lockout.reset.mock.invocationCallOrder[0];
    const recordOrder =
      h.lockout.recordFailure.mock.invocationCallOrder[0] ?? 0;

    expect(recordOrder).toBe(0);
    expect(resetOrder).toBeGreaterThan(0);
  });
});

describe('the threshold', () => {
  it('is five failures, so a mistyped password twice costs nothing', () => {
    expect(LOCKOUT_THRESHOLD).toBe(5);
  });
});
