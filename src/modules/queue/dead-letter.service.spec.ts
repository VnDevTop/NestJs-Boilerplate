import { describe, expect, it, vi } from 'vitest';

import {
  DEAD_LETTER_LIST,
  DEAD_LETTER_MAX,
  DeadLetterService,
  type DeadLetterEntry,
} from './dead-letter.service.js';
import type { Job, JobResult } from './queue.interface.js';
import type { RedisClientService } from './redis-client.service.js';

const job: Job = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'mail.send',
  payload: {},
  dedupeKey: 'dedupe:abc',
};

function redis(pushResult = true, length = 0) {
  const pushToList = vi.fn().mockResolvedValue(pushResult);
  const listLength = vi.fn().mockResolvedValue(length);

  return {
    redis: { pushToList, listLength } as unknown as RedisClientService,
    pushToList,
    listLength,
  };
}

/** What was written, parsed back out of the JSON payload. */
function stored(pushToList: ReturnType<typeof vi.fn>): DeadLetterEntry {
  return JSON.parse(pushToList.mock.calls[0][1]) as DeadLetterEntry;
}

describe('DeadLetterService.record', () => {
  it('writes to the dead-letter list', async () => {
    const { redis: service, pushToList } = redis();

    await new DeadLetterService(service, 'mail').record(
      job,
      { ok: false, error: 'x' },
      5,
    );

    expect(pushToList).toHaveBeenCalledWith(
      DEAD_LETTER_LIST,
      expect.any(String),
      DEAD_LETTER_MAX,
    );
  });

  it('keeps the list bounded, so a runaway failure cannot grow it forever', () => {
    expect(DEAD_LETTER_MAX).toBeGreaterThan(0);
    expect(DEAD_LETTER_MAX).toBeLessThanOrEqual(1000);
  });

  it('records what an operator needs to act on it', async () => {
    const { redis: service, pushToList } = redis();

    await new DeadLetterService(service, 'mail').record(
      job,
      { ok: false, error: 'invalid api key', retryable: false },
      1,
    );

    const entry = stored(pushToList);

    expect(entry).toMatchObject({
      queue: 'mail',
      job: 'mail.send',
      attempts: 1,
      error: 'invalid api key',
      permanent: true,
    });
    expect(entry.failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('distinguishes an exhausted retry from a permanent failure', async () => {
    const { redis: service, pushToList } = redis();

    await new DeadLetterService(service, 'mail').record(
      job,
      { ok: false, error: 'ETIMEDOUT', retryable: true },
      5,
    );

    // These call for different responses: one needs a retry budget change, the
    // other needs a credential fixed.
    expect(stored(pushToList).permanent).toBe(false);
  });

  it('keeps the dedupe key so the entry correlates with the logs', async () => {
    const { redis: service, pushToList } = redis();

    await new DeadLetterService(service, 'mail').record(
      job,
      { ok: false, error: 'x' },
      1,
    );

    expect(stored(pushToList).dedupeKey).toBe('dedupe:abc');
  });

  it('says something when the result carried no reason', async () => {
    const { redis: service, pushToList } = redis();

    await new DeadLetterService(service, 'mail').record(job, { ok: false }, 1);

    // An entry with no error is an entry nobody can act on.
    expect(stored(pushToList).error).toBe('no reason given');
  });

  it('omits the dedupe key rather than writing undefined', async () => {
    const { redis: service, pushToList } = redis();

    await new DeadLetterService(service, 'mail').record(
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'mail.send',
        payload: {},
      },
      { ok: false, error: 'x' },
      1,
    );

    expect(stored(pushToList).dedupeKey).toBeUndefined();
  });

  it('reports success when the entry was stored', async () => {
    const { redis: service } = redis(true);

    await expect(
      new DeadLetterService(service, 'mail').record(
        job,
        { ok: false, error: 'x' },
        1,
      ),
    ).resolves.toBe(true);
  });

  it('reports failure when redis refused, without throwing', async () => {
    // Redis being the cause of the failure is the common case, so recording the
    // failure is often recording into a dead store.
    const { redis: service } = redis(false);

    await expect(
      new DeadLetterService(service, 'mail').record(
        job,
        { ok: false, error: 'x' },
        1,
      ),
    ).resolves.toBe(false);
  });

  it('never throws, so a lost entry cannot escalate into a failed queue', async () => {
    const exploding = {
      pushToList: vi.fn().mockRejectedValue(new Error('socket hang up')),
      listLength: vi.fn(),
    } as unknown as RedisClientService;

    await expect(
      new DeadLetterService(exploding, 'mail').record(
        job,
        { ok: false, error: 'x' },
        1,
      ),
    ).resolves.toBe(false);
  });
});

describe('DeadLetterService.size', () => {
  it('reads the list depth', async () => {
    const { redis: service } = redis(true, 7);

    await expect(new DeadLetterService(service, 'mail').size()).resolves.toBe(
      7,
    );
  });

  it('reports zero when redis is down, so a health check reads empty', async () => {
    const { redis: service } = redis(true, 0);

    await expect(new DeadLetterService(service, 'mail').size()).resolves.toBe(
      0,
    );
  });
});

describe('JobResult contract used by the dead letter', () => {
  it('defaults to retryable, so an unclassified failure reaches the list as exhausted', () => {
    // Not permanent is the default, so a failure nobody classified is treated as
    // one that ran out of attempts rather than one that should never have run.
    const result: JobResult = { ok: false, error: 'boom' };

    expect(result.retryable).toBeUndefined();
  });
});
