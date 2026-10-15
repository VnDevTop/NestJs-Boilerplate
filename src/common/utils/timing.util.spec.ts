import { describe, expect, it, vi } from 'vitest';

import {
  padResponse,
  TIMING_FLOOR_MS,
  TIMING_JITTER_MS,
} from './timing.util.js';

/** Records what it was asked to wait for, so no test spends real time. */
function fakeSleep() {
  const waits: number[] = [];

  return {
    waits,
    sleep: (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

describe('padResponse', () => {
  it('waits for the floor when the branch was instant', async () => {
    const { waits, sleep } = fakeSleep();

    await padResponse({ startedAt: Date.now(), jitterMs: 0, sleep });

    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
  });

  it('does not wait when the branch was already slow enough', async () => {
    const { waits, sleep } = fakeSleep();

    await padResponse({
      startedAt: Date.now() - 5_000,
      jitterMs: 0,
      sleep,
    });

    expect(waits).toEqual([]);
  });

  it('adds jitter on top of the floor', async () => {
    // The clock is frozen because `padResponse` subtracts `Date.now()` from
    // `startedAt` itself, with no seam to inject one. On a real clock this
    // assertion is `125` only while zero milliseconds have elapsed, so it fails
    // under load — which is exactly when a full parallel suite runs it — and
    // passes on an idle machine. It read as a flake in `npm run check` and would
    // keep reading as one, on a security control whose whole job is to make two
    // branches indistinguishable in time.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    try {
      const { waits, sleep } = fakeSleep();

      await padResponse({
        startedAt: Date.now(),
        floorMs: 100,
        jitterMs: 50,
        random: () => 0.5,
        sleep,
      });

      expect(waits[0]).toBe(125);
    } finally {
      vi.useRealTimers();
    }
  });

  it('spreads the jitter across its range, so the wait is not a signature', async () => {
    // A fixed delay is as good as no delay once an attacker measures it: the
    // branches would still be separable by a constant offset.
    const low = await waitFor({
      startedAt: Date.now(),
      floorMs: 100,
      jitterMs: 50,
      random: () => 0,
    });
    const high = await waitFor({
      startedAt: Date.now(),
      floorMs: 100,
      jitterMs: 50,
      random: () => 0.99,
    });

    expect(low).toBeLessThan(high);
    expect(high - low).toBeGreaterThan(40);
  });

  it('subtracts the time already spent, rather than adding to it', async () => {
    const { waits, sleep } = fakeSleep();

    await padResponse({
      startedAt: Date.now() - 40,
      floorMs: 100,
      jitterMs: 0,
      sleep,
    });

    // 100 - 40, not 100 + 40: the floor is a total, not a tax.
    expect(waits[0]).toBeGreaterThanOrEqual(55);
    expect(waits[0]).toBeLessThanOrEqual(65);
  });

  it('never waits for a negative duration', async () => {
    // A branch already slower than the floor must not be pushed further back by
    // a jitter computed from an elapsed time that exceeds it.
    const { waits, sleep } = fakeSleep();

    await padResponse({
      startedAt: Date.now() - 10_000,
      floorMs: 100,
      jitterMs: 50,
      random: () => 0.99,
      sleep,
    });

    expect(waits).toEqual([]);
  });

  it('uses a floor large enough to cover a few database round trips', () => {
    // The mitigation only works while the real branch stays under the floor, so
    // the number is a stated budget rather than a preference.
    expect(TIMING_FLOOR_MS).toBeGreaterThanOrEqual(200);
    expect(TIMING_JITTER_MS).toBeGreaterThan(0);
    expect(TIMING_FLOOR_MS).toBeGreaterThan(TIMING_JITTER_MS);
  });

  it('defaults to that floor when a caller does not pick one', async () => {
    const { waits, sleep } = fakeSleep();

    await padResponse({ startedAt: Date.now(), jitterMs: 0, sleep });

    expect(waits[0]).toBeGreaterThanOrEqual(TIMING_FLOOR_MS - 20);
  });

  it('really does take the time it promises', async () => {
    // The other tests inject a fake sleep, so this one is the only check that
    // the wait is not merely recorded and skipped.
    const started = Date.now();
    await padResponse({ startedAt: started, floorMs: 60, jitterMs: 0 });

    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });
});

/** The wait a call would have used, without performing it. */
async function waitFor(options: {
  startedAt: number;
  floorMs: number;
  jitterMs: number;
  random: () => number;
}): Promise<number> {
  let waited = 0;

  await padResponse({ ...options, sleep: async (ms) => void (waited = ms) });

  return waited;
}
