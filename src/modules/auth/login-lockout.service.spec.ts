import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LoginLockedException } from './exceptions/login-locked.exception.js';
import {
  LOCKOUT_MAX_MINUTES,
  LOCKOUT_THRESHOLD,
  LoginLockoutService,
} from './login-lockout.service.js';
import type { RedisClientService } from '../queue/redis-client.service.js';

function harness(
  options: { getClientThrows?: boolean; getRejects?: boolean } = {},
) {
  const store = new Map<string, string>();

  const client = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, _opts?: { EX?: number }) => {
      store.set(key, value);

      return 'OK';
    }),
    del: vi.fn(async (...keys: (string | string[])[]) => {
      const flat = keys.flat();

      for (const key of flat) {
        store.delete(key);
      }

      return flat.length;
    }),
    incr: vi.fn(async (key: string) => {
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));

      return next;
    }),
    expire: vi.fn(async () => 1),
  };

  const getClient = options.getClientThrows
    ? vi.fn().mockRejectedValue(new Error('redis is unreachable'))
    : vi.fn().mockResolvedValue(client);

  const service = new LoginLockoutService({
    getClient,
  } as unknown as RedisClientService);

  return { service, client, store, getClient };
}

const EMAIL = 'victim@example.com';

describe('LoginLockoutService', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  describe('blockSeconds', () => {
    it('is one minute at the threshold', () => {
      expect(h.service.blockSeconds(LOCKOUT_THRESHOLD)).toBe(60);
    });

    it('adds a minute for each failure past the threshold', () => {
      expect(h.service.blockSeconds(LOCKOUT_THRESHOLD + 1)).toBe(120);
      expect(h.service.blockSeconds(LOCKOUT_THRESHOLD + 3)).toBe(240);
    });

    it('stops growing at the ceiling', () => {
      // The point of the ceiling: an unbounded multiplier lets one sustained
      // attack park an account for hours, which is a denial of service wearing a
      // defence as a costume.
      expect(h.service.blockSeconds(100)).toBe(LOCKOUT_MAX_MINUTES * 60);
      expect(h.service.blockSeconds(10_000)).toBe(LOCKOUT_MAX_MINUTES * 60);
    });

    it('never returns less than a second, however few failures', () => {
      expect(h.service.blockSeconds(0)).toBeGreaterThanOrEqual(60);
    });
  });

  describe('counting failures', () => {
    it('does not block before the threshold', async () => {
      for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i++) {
        expect((await h.service.recordFailure(EMAIL)).blocked).toBe(false);
      }
    });

    it('blocks on the failure that crosses the threshold', async () => {
      for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i++) {
        await h.service.recordFailure(EMAIL);
      }

      const state = await h.service.recordFailure(EMAIL);

      expect(state.blocked).toBe(true);
      expect(state.retryAfterSeconds).toBe(60);
    });

    it('flags only the attempt that starts the block', async () => {
      // Otherwise a caller who keeps guessing generates a notification per
      // request, and the login route becomes a way to mail somebody repeatedly.
      for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i++) {
        await h.service.recordFailure(EMAIL);
      }

      expect((await h.service.recordFailure(EMAIL)).firstBlock).toBe(true);
    });

    it('does not flag a failure before the block', async () => {
      expect((await h.service.recordFailure(EMAIL)).firstBlock).toBe(false);
    });

    it('extends the block while the account is still being tried', async () => {
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await h.service.recordFailure(EMAIL);
      }

      const during = await h.service.recordFailure(EMAIL);

      // Somebody hammering a locked account must not have the lock lapse while
      // they are still hammering it.
      expect(during.blocked).toBe(true);
      expect(during.firstBlock).toBe(false);
      expect(during.retryAfterSeconds).toBeGreaterThan(60);
    });

    it('gives the counter a ttl, so an old run of failures does not block forever', async () => {
      await h.service.recordFailure(EMAIL);

      expect(h.client.expire).toHaveBeenCalledTimes(1);
    });
  });

  describe('inspecting before an attempt', () => {
    it('allows an account with no record', async () => {
      expect((await h.service.inspect(EMAIL)).blocked).toBe(false);
    });

    it('blocks once the account is blocked', async () => {
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await h.service.recordFailure(EMAIL);
      }

      expect((await h.service.inspect(EMAIL)).blocked).toBe(true);
    });

    it('reports whole seconds, because Retry-After is in seconds', async () => {
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await h.service.recordFailure(EMAIL);
      }

      const state = await h.service.inspect(EMAIL);

      expect(Number.isInteger(state.retryAfterSeconds)).toBe(true);
      expect(state.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('never flags a block as the first one on inspection', async () => {
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await h.service.recordFailure(EMAIL);
      }

      // Inspection runs on every attempt, so if it said firstBlock here a busy
      // attacker would still produce a notification per request.
      expect((await h.service.inspect(EMAIL)).firstBlock).toBe(false);
    });

    it('allows again once the block has expired', async () => {
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await h.service.recordFailure(EMAIL);
      }

      // Time moved past the block while the key was still in the store.
      for (const key of [...h.store.keys()]) {
        if (!key.includes(':fail:')) {
          h.store.set(key, String(Date.now() - 1000));
        }
      }

      expect((await h.service.inspect(EMAIL)).blocked).toBe(false);
    });

    it('clears a stale key rather than trusting its ttl', async () => {
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await h.service.recordFailure(EMAIL);
      }

      for (const key of h.store.keys()) {
        if (!key.includes(':fail:')) {
          h.store.set(key, String(Date.now() - 1000));
        }
      }

      await h.service.inspect(EMAIL);

      // A lost write or a clock jump must not leave the account stuck.
      expect(h.client.del).toHaveBeenCalled();
    });
  });

  describe('after a successful sign-in', () => {
    it('clears the counter and the block', async () => {
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await h.service.recordFailure(EMAIL);
      }

      await h.service.reset(EMAIL);

      expect((await h.service.inspect(EMAIL)).blocked).toBe(false);
      expect(h.store.size).toBe(0);
    });

    it('lets the account start from a clean count', async () => {
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await h.service.recordFailure(EMAIL);
      }
      await h.service.reset(EMAIL);

      // Without the reset, one more mistake would block an honest user.
      expect((await h.service.recordFailure(EMAIL)).blocked).toBe(false);
    });
  });

  describe('the redis key', () => {
    it('does not contain the address', async () => {
      // Enough failures to cross the threshold, because the block key is only
      // written at that point. Testing after a single failure would pass with a
      // raw address in the key, since nothing had written one yet.
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await h.service.recordFailure(EMAIL);
      }

      // These keys are visible to anybody with redis access, so a key that reads
      // an address turns the instance into a mailing list.
      const keys = [...h.store.keys()].join(' ');

      expect(keys).not.toContain('victim');
      expect(keys).not.toContain('@');
    });

    it('counts one account once, whatever the spelling', async () => {
      // Five failures written three different ways must still be five failures,
      // not fifteen. Otherwise an attacker multiplies the budget by changing
      // case and whitespace per attempt.
      for (const spelling of [
        'victim@example.com',
        '  Victim@Example.COM  ',
        'VICTIM@EXAMPLE.COM',
        'victim@example.com',
        'Victim@example.com ',
      ]) {
        await h.service.recordFailure(spelling);
      }

      // The fifth attempt crossed the threshold on the shared counter.
      expect((await h.service.inspect('vIcTiM@eXaMpLe.CoM')).blocked).toBe(
        true,
      );
    });

    it('gives each address its own budget', async () => {
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await h.service.recordFailure('a@example.com');
      }

      // One shared key would let somebody block every account in the system by
      // failing five times against one of them.
      expect((await h.service.inspect('a@example.com')).blocked).toBe(true);
      expect((await h.service.inspect('b@example.com')).blocked).toBe(false);
    });
  });

  describe('when redis is unreachable', () => {
    beforeEach(() => {
      h = harness({ getClientThrows: true });
    });

    it('allows the attempt rather than locking anybody out', async () => {
      // Failing closed would let a cache outage lock every user out of login,
      // which is the worst response to an outage that is already costing money.
      expect((await h.service.inspect(EMAIL)).blocked).toBe(false);
    });

    it('reports no block when counting a failure', async () => {
      expect((await h.service.recordFailure(EMAIL)).blocked).toBe(false);
    });

    it('does not throw from reset', async () => {
      await expect(h.service.reset(EMAIL)).resolves.toBeUndefined();
    });
  });
});

describe('LoginLockedException', () => {
  it('is a 429', () => {
    expect(new LoginLockedException(60).getStatus()).toBe(429);
  });

  it('carries the wait for the Retry-After header', () => {
    expect(new LoginLockedException(90).retryAfterSeconds).toBe(90);
  });

  it('does not put the remaining time in the message', () => {
    // A body naming the time left is a progress bar for an attacker.
    const message = new LoginLockedException(3600).message;

    expect(message).not.toContain('3600');
    expect(message).not.toContain('60');
  });

  it('does not say the account exists', () => {
    expect(new LoginLockedException(60).message.toLowerCase()).not.toContain(
      'not found',
    );
  });
});
