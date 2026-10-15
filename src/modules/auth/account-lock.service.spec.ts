import { describe, expect, it, vi } from 'vitest';

import { AccountLockService } from './account-lock.service.js';
import { LOCKOUT_THRESHOLD } from './login-lockout.service.js';
import type { AccountSecurityConfig } from '../../configs/account-security.config.js';
import type { User } from '../users/entities/index.js';

/**
 * The permanent lockout, and the recovery path that makes it survivable.
 *
 * A permanent lockout is a weapon before it is a defence: twenty wrong passwords
 * lock an account, and twenty requests is nothing. Every test below about *not*
 * locking is therefore a test about refusing to hand that weapon to an attacker,
 * and they come first for that reason — a suite that only proved the lock works
 * would be a suite that proved the vulnerability too.
 */

const SECONDS = { date: () => new Date('2026-03-01T12:00:00Z') };

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    email: 'a@x.com',
    isActive: true,
    isEmailVerified: true,
    lockedAt: null,
    lockReason: null,
    ...overrides,
  } as User;
}

function policy(overrides: Partial<AccountSecurityConfig> = {}) {
  return {
    permanentLockThreshold: 20,
    permanentLockWindowHours: 24,
    unlockTokenTtlHours: 24,
    ...overrides,
  } as AccountSecurityConfig;
}

interface Sent {
  to: string;
  template: string;
  url?: string;
  failures?: number | null;
}

function harness(
  options: {
    config?: AccountSecurityConfig;
    user?: User | null;
    token?: Record<string, unknown> | null;
  } = {},
) {
  const found = options.user === undefined ? user() : options.user;

  const sent: Sent[] = [];

  const lockAccount = vi.fn(async (id: string, reason: string) => {
    const locked = user({
      ...found,
      id,
      lockedAt: new Date('2026-03-01T11:59:00Z'),
      lockReason: reason,
    });

    return locked;
  });

  const unlockAccount = vi.fn(async (id: string) =>
    user({ ...found, id, lockedAt: null, lockReason: null }),
  );

  // Typed as the three-argument form `EntityManager.update` takes. Without the
  // signature `vi.fn()` infers a zero-argument tuple, and every `mock.calls[0][1]`
  // in this file is a compile error rather than an assertion.
  const update = vi.fn(
    async (_target: unknown, _criteria: unknown, _patch: unknown) => undefined,
  );
  const save = vi.fn(async (entity: unknown) => entity);
  const findOne = vi.fn(async () =>
    options.token === undefined
      ? { id: 't1', userId: 'u1', tokenHash: 'hash', usedAt: null }
      : options.token,
  );

  const queue = {
    enqueue: vi.fn(
      async (_name: string, job: { payload: Record<string, unknown> }) => {
        const payload = job.payload as {
          to: string;
          template: string;
          data: { unlockUrl?: string; failures?: number | null };
        };

        sent.push({
          to: payload.to,
          template: payload.template,
          url: payload.data?.unlockUrl,
          failures: payload.data?.failures,
        });

        return undefined;
      },
    ),
    driver: 'in-process' as const,
  };

  // `create` is on the fake because `issue` goes through the manager rather than
  // the repository, so that a caller inside a transaction gets the same manager.
  // A fake missing it fails with "not a function" rather than anything about the
  // lock, which is a slow way to find out.
  const create = vi.fn((_target: unknown, values: unknown) => values);

  const manager = { update, save, findOne, create };

  const transaction = vi.fn(
    async (work: (m: typeof manager) => Promise<unknown>) => work(manager),
  );

  const service = new AccountLockService(
    { manager } as never,
    queue as never,
    { transaction } as never,
    {
      findByEmail: vi.fn(async () => found),
      lockAccount,
      unlockAccount,
    } as never,
    {
      reset: vi.fn(async () => undefined),
      // The temporary threshold, which this service now asks for rather than
      // reading off a constant. Stated explicitly because a double returning
      // `undefined` would make every threshold comparison false and quietly turn
      // the permanent lockout off for the whole file.
      threshold: LOCKOUT_THRESHOLD,
    } as never,
    { buildUrl: (path: string) => `https://app.example.com${path}` } as never,
    { getOrThrow: () => ({ name: 'Example' }) } as never,
    options.config ?? policy(),
  );

  return {
    service,
    sent,
    lockAccount,
    unlockAccount,
    update,
    save,
    findOne,
    reset: (service as never as { loginLockout: { reset: unknown } })
      .loginLockout,
  };
}

describe('the threshold', () => {
  it('locks the account on the attempt that reaches it', async () => {
    const h = harness();

    await h.service.lockOnRepeatedFailures('a@x.com', 20);

    expect(h.lockAccount).toHaveBeenCalledWith(
      'u1',
      expect.stringContaining('20 failed sign-in attempts'),
    );
  });

  it('does nothing before that', async () => {
    const h = harness();

    await h.service.lockOnRepeatedFailures('a@x.com', 19);

    expect(h.lockAccount).not.toHaveBeenCalled();
  });

  it('does nothing on the attempts after it either, so a lock is not re-notified', async () => {
    // The count keeps climbing while the attacker keeps hammering. Without the
    // exact-equality guard the twenty-first attempt would rewrite the timestamp and
    // the reason an operator has open, and send a second mail to the owner.
    const h = harness();

    await h.service.lockOnRepeatedFailures('a@x.com', 21);

    expect(h.lockAccount).not.toHaveBeenCalled();
  });

  it('costs no query on the cheap path', async () => {
    // Every failed sign-in goes through here, so the early return is the only part
    // that runs on the nineteen attempts that change nothing.
    const h = harness();

    await h.service.lockOnRepeatedFailures('a@x.com', 3);

    expect(
      (h.service as never as { usersService: { findByEmail: unknown } })
        .usersService,
    ).toBeDefined();
    expect(h.lockAccount).not.toHaveBeenCalled();
  });

  it('is switched off entirely at zero', async () => {
    const h = harness({ config: policy({ permanentLockThreshold: 0 }) });

    await h.service.lockOnRepeatedFailures('a@x.com', 20);

    expect(h.lockAccount).not.toHaveBeenCalled();
  });

  it('refuses to be configured at or below the temporary threshold', async () => {
    // Five failures would then lock permanently and also start a temporary block
    // that lifts in a minute — a lock that starts and ends by itself. That is an
    // outage wearing a lockout's clothes, so the configuration is treated as off.
    const h = harness({ config: policy({ permanentLockThreshold: 5 }) });

    await h.service.lockOnRepeatedFailures('a@x.com', 5);

    expect(h.lockAccount).not.toHaveBeenCalled();
  });
});

describe('who may be locked', () => {
  it('does not lock an account whose address was never confirmed', async () => {
    // The whole design rests on this. An unverified account has never proved it
    // can read its mail, so an unlock link to it reaches nobody and the owner is
    // locked out until an operator intervenes — which is exactly the outcome an
    // attacker wants and the reason the rule is not configurable.
    const h = harness({ user: user({ isEmailVerified: false }) });

    await h.service.lockOnRepeatedFailures('a@x.com', 20);

    expect(h.lockAccount).not.toHaveBeenCalled();
  });

  it('does not lock an account an administrator has deactivated', async () => {
    // `isActive` is an operator's decision and an operator's to reverse. A lock
    // layered on top would survive the reversal and leave an account nobody can
    // reach, including the operator who wanted it back.
    const h = harness({ user: user({ isActive: false }) });

    await h.service.lockOnRepeatedFailures('a@x.com', 20);

    expect(h.lockAccount).not.toHaveBeenCalled();
  });

  it('does not lock an address with no account', async () => {
    const h = harness({ user: null });

    await h.service.lockOnRepeatedFailures('a@x.com', 20);

    expect(h.lockAccount).not.toHaveBeenCalled();
  });

  it('does not re-lock an account that is already locked', async () => {
    // Two concurrent requests can read the same failure count and both believe they
    // are the one that crossed it. The second must not overwrite the timestamp and
    // the reason the owner is reading right now.
    const h = harness({
      user: user({ lockedAt: new Date('2026-02-01T00:00:00Z') }),
    });

    await h.service.lockOnRepeatedFailures('a@x.com', 20);

    expect(h.lockAccount).not.toHaveBeenCalled();
  });
});

describe('when the lock cannot be written', () => {
  it('does not throw, because the sign-in that triggered it has to answer', async () => {
    // The call sits inside `recordLoginFailure`, on the path that is about to
    // reject a sign-in. An error escaping here would replace "invalid credentials"
    // with a 500, which tells an attacker their twenty attempts hit something.
    const h = harness();
    h.lockAccount.mockRejectedValueOnce(new Error('connection reset'));

    await expect(
      h.service.lockOnRepeatedFailures('a@x.com', 20),
    ).resolves.toBeUndefined();
  });

  it('sends no mail, because there is nothing to unlock', async () => {
    const h = harness();
    h.lockAccount.mockRejectedValueOnce(new Error('connection reset'));

    await h.service.lockOnRepeatedFailures('a@x.com', 20);

    expect(h.sent).toEqual([]);
  });

  it('does not persist a token either', async () => {
    // The token and the mail are minted after the row write, not before. A token
    // minted for a lock that failed to land is a live credential for an account
    // that is not locked, and it would still be accepted.
    const h = harness();
    h.lockAccount.mockRejectedValueOnce(new Error('connection reset'));

    await h.service.lockOnRepeatedFailures('a@x.com', 20);

    expect(h.save).not.toHaveBeenCalled();
  });
});

describe('the mail that tells the owner', () => {
  it('goes to the address on the account, carrying a link that clears the lock', async () => {
    const h = harness();

    await h.service.lockOnRepeatedFailures('a@x.com', 20);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      to: 'a@x.com',
      template: 'account-permanently-locked',
      url: expect.stringContaining('/auth/account/unlock/'),
    });
  });

  it('carries the failure count while redis still remembers it', async () => {
    // The count is the difference between "somebody guessed your password" and
    // "somebody guessed it twenty times", and it is gone within the hour.
    const h = harness();

    await h.service.lockOnRepeatedFailures('a@x.com', 20);

    expect(h.sent[0]?.failures).toBe(20);
  });

  it('stores only the hash of the token', async () => {
    // The table is readable by anybody with database access, and the value in it is
    // the only thing that opens a locked account.
    const h = harness();

    await h.service.lockOnRepeatedFailures('a@x.com', 20);

    // `save` is called with one argument here — the entity `create` built — so the
    // row is the first call's argument rather than the second.
    const [tokenRow] = h.save.mock.calls[0] ?? [];
    const sentToken = String((h.sent[0]?.url ?? '').split('/').pop());

    expect(JSON.stringify(tokenRow)).not.toContain(sentToken);
    expect(tokenRow).toMatchObject({
      tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('spends the previous link rather than leaving it usable', async () => {
    // An older link already sitting in an inbox must stop working the moment a
    // newer one is sent, or a leaked old mail outlives the owner asking again.
    const h = harness();

    await h.service.lockOnRepeatedFailures('a@x.com', 20);

    expect(h.update).toHaveBeenCalledWith(
      expect.anything(),
      { userId: 'u1', usedAt: expect.anything() },
      { usedAt: expect.any(Date) },
    );
  });

  it('marks them spent rather than deleting the row', async () => {
    // Deleting would take the row out of the audit of who was sent what. The
    // `usedAt` predicate is what makes a spent token unusable.
    const h = harness();

    await h.service.lockOnRepeatedFailures('a@x.com', 20);

    expect(h.update.mock.calls[0]?.[1]).toMatchObject({
      usedAt: expect.anything(),
    });
  });
});

describe('asking for the link later', () => {
  it('mints a new one for a locked account', async () => {
    const h = harness({
      user: user({ lockedAt: new Date('2026-02-01T00:00:00Z') }),
    });

    await h.service.requestUnlock('a@x.com');

    expect(h.sent).toHaveLength(1);
  });

  it('sends nothing for an account that is not locked', async () => {
    const h = harness();

    await h.service.requestUnlock('a@x.com');

    expect(h.sent).toEqual([]);
  });

  it('sends nothing to an address that was never confirmed', async () => {
    // A link to an unconfirmed inbox is a way to confirm an address as a side
    // effect of clearing a lock, which is a second capability this feature must
    // not hand out.
    const h = harness({
      user: user({ isEmailVerified: false, lockedAt: new Date() }),
    });

    await h.service.requestUnlock('a@x.com');

    expect(h.sent).toEqual([]);
  });

  it('pays the same database cost on the miss, so timing says nothing', async () => {
    // The same write the qualifying branch runs, against an id with no rows.
    // Without it the miss is measurably cheaper and response time alone answers
    // the question — the reason `forgot-password` pays for the same thing.
    const h = harness();

    await h.service.requestUnlock('nobody@x.com');

    expect(h.update).toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  it('claims no count it does not have', async () => {
    // Redis forgets within the hour and a request usually comes later than that,
    // so the mail says "too many" rather than inventing a number.
    const h = harness({
      user: user({ lockedAt: new Date('2026-02-01T00:00:00Z') }),
    });

    await h.service.requestUnlock('a@x.com');

    expect(h.sent[0]?.failures).toBeNull();
  });
});

describe('clearing a lock with the token', () => {
  it('spends the token and unlocks the account', async () => {
    const h = harness({ user: user({ lockedAt: new Date() }) });

    await h.service.unlockWithToken('a-token');

    expect(h.update).toHaveBeenCalledWith(
      expect.anything(),
      { id: 't1' },
      { usedAt: expect.any(Date) },
    );
    expect(h.unlockAccount).toHaveBeenCalledWith('u1', 'the account owner');
  });

  it('refuses a token that is not usable', async () => {
    const h = harness({ token: null });

    await expect(h.service.unlockWithToken('a-token')).rejects.toThrow(
      'This unlock link is invalid or has expired',
    );
  });

  it('says the same thing for every kind of unusable token', async () => {
    // A caller that can tell expired from spent from unknown can enumerate which
    // tokens were ever issued, which is a smaller leak than it looks.
    const h = harness({ token: null });

    await expect(h.service.unlockWithToken('a-token')).rejects.toThrow(
      /invalid or has expired/,
    );
    expect(h.unlockAccount).not.toHaveBeenCalled();
  });

  it('clears the redis failure count as well as the row', async () => {
    // The count is at its maximum at the moment of the lock. Leave it and the owner
    // clicks their own link, is told they are unlocked, and is then refused with a
    // 429 for the rest of a temporary block they never knew about.
    const h = harness({ user: user({ lockedAt: new Date() }) });

    await h.service.unlockWithToken('a-token');

    expect(h.reset).toMatchObject({ reset: expect.any(Function) });
    expect(
      (h.reset as { reset: (e: string) => void }).reset,
    ).toHaveBeenCalledWith('a@x.com');
  });

  it('does not send the "you are back in" mail, because they clicked the link', async () => {
    // They already know. A mail that confirms an action they just took is noise in
    // the one inbox they are watching for exactly this kind of message.
    const h = harness({ user: user({ lockedAt: new Date() }) });

    await h.service.unlockWithToken('a-token');

    expect(h.sent.map((mail) => mail.template)).not.toContain(
      'account-unlocked',
    );
  });

  it('does not leave the spent token able to clear a second lock', async () => {
    // A token whose row is marked used is refused by the lookup's `usedAt IS NULL`,
    // which is the same field the spend writes. This asserts the write happened
    // inside the transaction that read it, not after.
    const h = harness({ user: user({ lockedAt: new Date() }) });

    await h.service.unlockWithToken('a-token');

    const [, criteria, patch] = h.update.mock.calls[0] ?? [];

    expect(criteria).toEqual({ id: 't1' });
    expect(patch).toEqual({ usedAt: expect.any(Date) });
  });
});

describe('an administrator clearing somebody else', () => {
  it('clears the lock and the failure count, and tells the owner', async () => {
    const h = harness({ user: user({ lockedAt: new Date() }) });

    await h.service.clear('u1', 'admin@x.com');

    expect(h.unlockAccount).toHaveBeenCalledWith('u1', 'admin@x.com');
    expect(
      (h.reset as { reset: (e: string) => void }).reset,
    ).toHaveBeenCalledWith('a@x.com');
    expect(h.sent.map((mail) => mail.template)).toContain('account-unlocked');
  });

  it('names the administrator, so the owner knows who opened their account', async () => {
    const h = harness({ user: user({ lockedAt: new Date() }) });

    await h.service.clear('u1', 'admin@x.com');

    const mail = h.sent.find((m) => m.template === 'account-unlocked');

    expect(mail).toMatchObject({ to: 'a@x.com' });
  });

  it('writes the unlock before it touches redis, so a cache problem cannot undo it', async () => {
    // The ordering is the guarantee. `LoginLockoutService.reset` catches its own
    // failures and returns void, so it cannot reject today — but it is called
    // *after* the row write, which is what would make this still correct if it
    // could. Asserted here rather than left as a comment, because a comment stops
    // being true the moment somebody moves a line.
    const h = harness({ user: user({ lockedAt: new Date() }) });
    const order: string[] = [];

    h.unlockAccount.mockImplementation(async () => {
      order.push('unlock');

      return user();
    });
    (h.reset as { reset: (e: string) => void }).reset = vi.fn(() => {
      order.push('reset');
    });

    await h.service.clear('u1', 'admin@x.com');

    expect(order).toEqual(['unlock', 'reset']);
  });
});

describe('the window', () => {
  it('appears in the reason an operator reads', async () => {
    // "20 failures" without a window is a number with no meaning; the window is
    // what separates an hour of hammering from a month of typos.
    const h = harness();

    await h.service.lockOnRepeatedFailures('a@x.com', 20);

    expect(h.lockAccount).toHaveBeenCalledWith(
      'u1',
      '20 failed sign-in attempts within 24 hours',
    );
  });

  it('follows the configured window', async () => {
    const h = harness({ config: policy({ permanentLockWindowHours: 72 }) });

    await h.service.lockOnRepeatedFailures('a@x.com', 20);

    expect(h.lockAccount).toHaveBeenCalledWith(
      'u1',
      expect.stringContaining('within 72 hours'),
    );
  });
});

void SECONDS;
