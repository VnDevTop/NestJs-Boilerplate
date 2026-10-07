import { describe, expect, it } from 'vitest';

import { TIMING_FLOOR_MS } from '../../common/utils/index.js';
import { AuthService } from './auth.service.js';

const appConfig = {
  name: 'Example',
  env: 'test',
  url: 'https://app.example.com',
};

/** Keeps the real padding, so the timing is actually measured. */
class TimedAuthService extends AuthService {}

function harness(options: {
  userExists?: boolean;
  userActive?: boolean;
  /** Artificial cost of the database work, in fake milliseconds. */
  dbCostMs?: number;
}) {
  const dbCost = options.dbCostMs ?? 0;

  /** Counts round trips per table, which is the thing being equalised. */
  const queries: string[] = [];

  const slow = async <T>(table: string, value: T): Promise<T> => {
    queries.push(table);

    if (dbCost > 0) {
      // A real await, so the two branches really do take different times.
      await new Promise((resolve) => setTimeout(resolve, dbCost));
    }

    return value;
  };

  const user =
    options.userExists === false
      ? null
      : {
          id: 'user-1',
          email: 'a@x.com',
          isActive: options.userActive ?? true,
          isEmailVerified: false,
        };

  const usersService = {
    findByEmail: () => slow('users', user),
  };

  const passwordResetService = {
    issue: async () => {
      queries.push('password_reset_tokens:update');
      await new Promise((resolve) => setTimeout(resolve, dbCost));

      return {
        token: 't',
        expiresAt: new Date(Date.now() + 30 * 60_000),
      };
    },
    spendOutstandingFor: () => slow('password_reset_tokens:update', undefined),
  };

  const emailVerificationService = {
    issue: async () => {
      queries.push('email_verification_tokens:update');
      await new Promise((resolve) => setTimeout(resolve, dbCost));

      return { token: 't', expiresAt: new Date(Date.now() + 24 * 3_600_000) };
    },
    spendOutstandingFor: () =>
      slow('email_verification_tokens:update', undefined),
  };

  const jobQueue = {
    enqueue: vi.fn().mockResolvedValue(undefined),
    driver: 'in-process' as const,
  };

  const mailService = {
    sendTemplate: () => Promise.resolve({ mailId: 'm', delivered: true }),
    buildUrl: (path: string) => `https://app.example.com${path}`,
  };

  const service = new TimedAuthService(
    {} as never,
    usersService as never,
    {} as never,
    {} as never,
    {} as never,
    passwordResetService as never,
    emailVerificationService as never,
    mailService as never,
    jobQueue as never,
    { getOrThrow: () => appConfig } as never,
    {
      // The lockout counts failures in redis, which these tests do not stand up.
      // Reporting no block keeps each test testing what it was written for; the
      // lockout itself is tested in login-lockout.service.spec.ts.
      inspect: () =>
        Promise.resolve({
          blocked: false,
          retryAfterSeconds: 0,
          firstBlock: false,
        }),
      recordFailure: () =>
        Promise.resolve({
          blocked: false,
          retryAfterSeconds: 0,
          firstBlock: false,
        }),
      reset: () => Promise.resolve(undefined),
    } as never,
  );

  return { service, queries };
}

describe('forgotPassword timing', () => {
  it('does the same database work whether or not the address is registered', async () => {
    // The message alone is not enough. If one branch runs fewer statements, the
    // difference shows in the response time and the route enumerates accounts
    // without any statistics at all.
    const known = harness({});
    const unknown = harness({ userExists: false });

    await known.service.forgotPassword({ email: 'a@x.com' }, '1.1.1.1');
    await unknown.service.forgotPassword({ email: 'a@x.com' }, '1.1.1.1');

    expect(unknown.queries).toEqual(known.queries);
  });

  it('pays for the token table on the miss path too', async () => {
    const unknown = harness({ userExists: false });

    await unknown.service.forgotPassword({ email: 'a@x.com' }, '1.1.1.1');

    expect(unknown.queries).toContain('password_reset_tokens:update');
  });

  it('holds both answers for the floor, not just the slow one', async () => {
    // The difference assertion below passes even with the padding removed,
    // because the simulated database cost is small. This is the assertion that
    // actually pins the padding: whatever the branch did, the caller waited.
    const known = harness({ dbCostMs: 0 });
    const unknown = harness({ userExists: false, dbCostMs: 0 });

    const startedMiss = Date.now();
    await unknown.service.forgotPassword({ email: 'a@x.com' }, '1.1.1.1');
    const missMs = Date.now() - startedMiss;

    const startedHit = Date.now();
    await known.service.forgotPassword({ email: 'a@x.com' }, '1.1.1.1');
    const hitMs = Date.now() - startedHit;

    expect(missMs).toBeGreaterThanOrEqual(TIMING_FLOOR_MS - 20);
    expect(hitMs).toBeGreaterThanOrEqual(TIMING_FLOOR_MS - 20);
  });

  it('holds the resend answers for the floor too', async () => {
    const unknown = harness({ userExists: false, dbCostMs: 0 });

    const started = Date.now();
    await unknown.service.resendVerification({ email: 'a@x.com' }, '1.1.1.1');

    expect(Date.now() - started).toBeGreaterThanOrEqual(TIMING_FLOOR_MS - 20);
  });

  it('takes about the same time on both paths', async () => {
    // 20ms of simulated database work per statement, and a real measurement.
    const known = harness({ dbCostMs: 20 });
    const unknown = harness({ userExists: false, dbCostMs: 20 });

    const started = Date.now();
    await unknown.service.forgotPassword({ email: 'a@x.com' }, '1.1.1.1');
    const missMs = Date.now() - started;

    const startedHit = Date.now();
    await known.service.forgotPassword({ email: 'a@x.com' }, '1.1.1.1');
    const hitMs = Date.now() - startedHit;

    // The floor dominates any difference, so what is asserted is that neither
    // path is meaningfully slower than the other.
    expect(Math.abs(hitMs - missMs)).toBeLessThan(60);
  });

  it('answers a deactivated account as slowly as a hit', async () => {
    // "Deactivated" must not be the slow one either, or the route still
    // enumerates the accounts that are merely switched off.
    const inactive = harness({ userActive: false });
    const known = harness({});

    const started = Date.now();
    await inactive.service.forgotPassword({ email: 'a@x.com' }, '1.1.1.1');
    const inactiveMs = Date.now() - started;

    const startedHit = Date.now();
    await known.service.forgotPassword({ email: 'a@x.com' }, '1.1.1.1');
    const hitMs = Date.now() - startedHit;

    expect(Math.abs(hitMs - inactiveMs)).toBeLessThan(60);
  });
});

describe('resendVerification timing', () => {
  it('does the same database work for unknown and unverified addresses', async () => {
    const unknown = harness({ userExists: false });
    const known = harness({});

    await unknown.service.resendVerification({ email: 'a@x.com' }, '1.1.1.1');
    await known.service.resendVerification({ email: 'a@x.com' }, '1.1.1.1');

    expect(unknown.queries).toEqual(known.queries);
  });

  it('answers a known address as slowly as an unknown one', async () => {
    // Three outcomes have to be indistinguishable, not two.
    const verified = harness({});

    const started = Date.now();
    await verified.service.resendVerification({ email: 'a@x.com' }, '1.1.1.1');
    const verifiedMs = Date.now() - started;

    const other = harness({ userExists: false });
    const startedOther = Date.now();
    await other.service.resendVerification({ email: 'a@x.com' }, '1.1.1.1');
    const unknownMs = Date.now() - startedOther;

    expect(Math.abs(verifiedMs - unknownMs)).toBeLessThan(60);
  });
});
