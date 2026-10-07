import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RedisClientService } from '../redis-client.service.js';
import { THROTTLE_SCRIPT } from './throttler-script.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';

function harness(result: unknown[] | null) {
  const eval_ = vi.fn().mockResolvedValue(result);

  return {
    storage: new RedisThrottlerStorage({
      eval: eval_,
    } as unknown as RedisClientService),
    eval_,
  };
}

/** What the script returns on a normal, unblocked call. */
const record = (
  totalHits: number,
  timeToExpire: number,
  isBlocked: number,
  timeToBlockExpire = 0,
) =>
  [totalHits, timeToExpire, isBlocked, timeToBlockExpire] as [
    number,
    number,
    number,
    number,
  ];

describe('RedisThrottlerStorage', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness(record(1, 59_000, 0));
  });

  describe('the key it writes', () => {
    it('is namespaced and carries the throttler name', async () => {
      await h.storage.increment('tracker-id', 60_000, 100, 0, 'default');

      // Two throttlers tracking the same caller must not share a counter, or the
      // strictest one silently governs all of them.
      expect(h.eval_.mock.calls[0][1]).toEqual(['throttle:default:tracker-id']);
    });

    it('separates named throttlers', async () => {
      await h.storage.increment('k', 60_000, 100, 0, 'login');

      expect(h.eval_.mock.calls[0][1]).toEqual(['throttle:login:k']);
    });
  });

  describe('the arguments it passes', () => {
    it('passes ttl, limit, blockDuration and now, in that order', async () => {
      const before = Date.now();

      await h.storage.increment('k', 60_000, 7, 30_000, 'default');

      const args = h.eval_.mock.calls[0][2];

      expect(args[0]).toBe(60_000);
      expect(args[1]).toBe(7);
      expect(args[2]).toBe(30_000);
      expect(args[3]).toBeGreaterThanOrEqual(before);
    });
  });

  describe('reading the script result', () => {
    it('maps the tuple onto the record the throttler expects', async () => {
      h = harness(record(9, 12_000, 0));

      const result = await h.storage.increment('k', 60_000, 100, 0, 'default');

      expect(result).toEqual({
        totalHits: 9,
        timeToExpire: 12_000,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
    });

    it('treats 1 as blocked, because Lua returns a number', async () => {
      h = harness(record(5, 0, 1, 30_000));

      const result = await h.storage.increment(
        'k',
        60_000,
        5,
        30_000,
        'default',
      );

      // Declaring this field a boolean would make the compiler believe `=== 1`
      // cannot happen, and a permanently blocked caller would be let through.
      expect(result.isBlocked).toBe(true);
      expect(result.timeToBlockExpire).toBe(30_000);
    });

    it('clamps a negative expiry to zero rather than passing it on', async () => {
      h = harness(record(1, -5, 0));

      const result = await h.storage.increment('k', 60_000, 100, 0, 'default');

      // A negative Retry-After header is worse than a useless one.
      expect(result.timeToExpire).toBe(0);
    });

    it('clamps a negative block expiry too', async () => {
      h = harness(record(1, 0, 1, -1));

      const result = await h.storage.increment(
        'k',
        60_000,
        1,
        60_000,
        'default',
      );

      expect(result.timeToBlockExpire).toBe(0);
    });
  });

  describe('when redis is unavailable', () => {
    beforeEach(() => {
      h = harness(null);
    });

    it('allows the request', async () => {
      // Failing closed would make redis an availability dependency of every
      // endpoint, so a cache outage would lock every user out of login.
      const result = await h.storage.increment('k', 60_000, 1, 0, 'default');

      expect(result.isBlocked).toBe(false);
    });

    it('reports a single hit, so the headers do not imply a caller is nearly blocked', async () => {
      const result = await h.storage.increment('k', 60_000, 100, 0, 'default');

      // `X-RateLimit-Remaining` is derived from this. Reporting the real limit
      // here would tell a client its budget survived an outage it never spent.
      expect(result.totalHits).toBe(1);
    });

    it('never throws', async () => {
      await expect(
        h.storage.increment('k', 60_000, 1, 0, 'default'),
      ).resolves.toBeDefined();
    });

    it('gives a positive window, so no header goes out as zero', async () => {
      const result = await h.storage.increment('k', 60_000, 1, 0, 'default');

      expect(result.timeToExpire).toBeGreaterThan(0);
    });
  });

  describe('the script itself', () => {
    it('runs as one atomic step rather than a read and a write', () => {
      // A read followed by a write lets two concurrent requests both see the same
      // count and both be allowed, which is the burst an attacker sends.
      expect(THROTTLE_SCRIPT).toMatch(/HINCRBY/);
      expect(THROTTLE_SCRIPT).not.toMatch(
        /\n\s*local .*= redis\.call\('HGET'[^\n]*\n[\s\S]*?redis\.call\('HINCRBY'/,
      );
    });

    it('uses millisecond expiry, matching what the throttler passes', () => {
      expect(THROTTLE_SCRIPT).toContain('PEXPIRE');
      expect(THROTTLE_SCRIPT).not.toMatch(/\bEXPIRE\b/);
    });

    it('does not extend the block when a blocked request arrives', () => {
      // Otherwise every retry into a block pushes the end further out, and a
      // client polling in a loop is never released.
      expect(THROTTLE_SCRIPT).toMatch(
        /if blockedUntil > now then[\s\S]*?return \{ hits, expiresAt - now, 1, blockedUntil - now \}\s*end/,
      );
    });

    it('resets the counter when it blocks, so the block is temporary', () => {
      // Without this the counter is still above the limit when the block lifts,
      // the next request re-blocks, and a temporary lockout becomes permanent.
      expect(THROTTLE_SCRIPT).toContain("redis.call('HSET', key, 'hits', 0)");
    });

    it('returns 1 rather than true, because a lua table holds numbers', () => {
      expect(THROTTLE_SCRIPT).toMatch(/return \{[^\n]*, 1,/);
    });
  });
});
