import { describe, expect, it, vi } from 'vitest';

import { dedupeKey } from './dedupe-key.js';
import { DedupeGuard } from './dedupe.guard.js';
import type { ProcessorRegistry } from './in-process.dispatcher.js';
import type { Job, JobResult } from './queue.interface.js';
import type { RedisClientService } from './redis-client.service.js';
import { retryWindowMs } from './retry.policy.js';

const subject = { template: 'welcome', to: 'a@x.com', subjectId: 'u1' };

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'mail.send',
    payload: {},
    dedupeKey: dedupeKey(subject),
    ...overrides,
  };
}

/** A redis whose SET NX and DEL answers the test decides. */
function redis(setResult: boolean | null, releaseResult = true) {
  const setIfAbsent = vi.fn().mockResolvedValue(setResult);
  const release = vi.fn().mockResolvedValue(releaseResult);

  return {
    redis: { setIfAbsent, release } as unknown as RedisClientService,
    setIfAbsent,
    release,
  };
}

function inner(result: JobResult | 'throw'): ProcessorRegistry & {
  calls: Job[];
} {
  const calls: Job[] = [];

  return {
    calls,
    process: async (enqueued: Job) => {
      calls.push(enqueued);

      if (result === 'throw') {
        throw new Error('processor exploded');
      }

      return result;
    },
  };
}

const ok: JobResult = { ok: true };
const transient: JobResult = { ok: false, error: 'ETIMEDOUT', retryable: true };
const permanent: JobResult = { ok: false, error: 'bad key', retryable: false };

describe('dedupeKey', () => {
  it('is stable for the same intent', () => {
    expect(dedupeKey(subject)).toBe(dedupeKey(subject));
  });

  it('differs by template, so two mails to one address are not one job', () => {
    expect(dedupeKey(subject)).not.toBe(
      dedupeKey({ ...subject, template: 'verify-email' }),
    );
  });

  it('differs by subject id, so asking twice still sends twice', () => {
    // Without this, a user who requests two reset mails in a minute gets one.
    expect(dedupeKey(subject)).not.toBe(
      dedupeKey({ ...subject, subjectId: 'u2' }),
    );
  });

  it('treats the address case-insensitively', () => {
    expect(dedupeKey(subject)).toBe(dedupeKey({ ...subject, to: 'A@X.com' }));
  });

  it('ignores surrounding whitespace on the address', () => {
    expect(dedupeKey(subject)).toBe(dedupeKey({ ...subject, to: ' a@x.com ' }));
  });

  it('puts no address in the key, because it lands in redis', () => {
    // A raw address here would be a copy of the user table in a place nobody
    // thinks to protect, and it shows up in a KEYS listing during an incident.
    const key = dedupeKey({ ...subject, to: 'ada@example.com' });

    expect(key).not.toContain('example.com');
    expect(key).toMatch(/^dedupe:[0-9a-f]{64}$/);
  });

  it('cannot be confused by a separator inside a field', () => {
    // 'a' + 'b|c' and 'a|b' + 'c' join to the same string, so the separator has
    // to be unambiguous or two different jobs collide.
    expect(dedupeKey({ template: 'a', to: 'b|c', subjectId: 'd' })).not.toBe(
      dedupeKey({ template: 'a|b', to: 'c', subjectId: 'd' }),
    );
  });
});

describe('DedupeGuard ttl', () => {
  it('outlives the whole retry window, not one attempt', () => {
    // A key that expires mid-retry lets a redelivery through as a new job.
    const guard = new DedupeGuard(
      inner(ok).process as never,
      redis(true).redis,
    );

    expect(guard.ttl * 1000).toBeGreaterThanOrEqual(
      retryWindowMs({ delay: 1000, attempts: 5 }),
    );
  });

  it('grows with a longer retry budget', () => {
    const short = new DedupeGuard(
      inner(ok).process as never,
      redis(true).redis,
      {
        backoff: { attempts: 2, delay: 1000 },
      },
    );
    const long = new DedupeGuard(
      inner(ok).process as never,
      redis(true).redis,
      {
        backoff: { attempts: 10, delay: 1000 },
      },
    );

    expect(long.ttl).toBeGreaterThan(short.ttl);
  });
});

describe('DedupeGuard when the key is free', () => {
  it('runs the work', async () => {
    const processor = inner(ok);
    const guard = new DedupeGuard(processor, redis(true).redis);

    await guard.process(job());

    expect(processor.calls).toHaveLength(1);
  });

  it('holds the key after a success, which is the whole mechanism', async () => {
    const { redis: service, release } = redis(true);
    const guard = new DedupeGuard(inner(ok), service);

    await guard.process(job());

    expect(release).not.toHaveBeenCalled();
  });

  it('holds the key after a permanent failure, since the job is finished', async () => {
    const { redis: service, release } = redis(true);

    await new DedupeGuard(inner(permanent), service).process(job());

    // Releasing here would let a stale redelivery try a job already given up on.
    expect(release).not.toHaveBeenCalled();
  });
});

describe('DedupeGuard when the key is held', () => {
  it('skips the work, so a redelivery sends no second email', async () => {
    const processor = inner(ok);
    const guard = new DedupeGuard(processor, redis(false).redis);

    await guard.process(job());

    expect(processor.calls).toHaveLength(0);
  });

  it('reports success, so bullmq does not burn the retry budget', async () => {
    const guard = new DedupeGuard(inner(ok), redis(false).redis);

    // Reporting a failure here would retry a job that is not broken.
    await expect(guard.process(job())).resolves.toEqual({ ok: true });
  });

  it('never releases a key it did not claim', async () => {
    const { redis: service, release } = redis(false);

    await new DedupeGuard(inner(ok), service).process(job());

    expect(release).not.toHaveBeenCalled();
  });
});

describe('DedupeGuard on a retryable failure', () => {
  it('releases the key, or the retry is swallowed', async () => {
    const { redis: service, release } = redis(true);
    const guard = new DedupeGuard(inner(transient), service);

    await guard.process(job());

    // The failure this guards against: the key stays held, the retry is skipped,
    // bullmq records success, and the mail is never delivered.
    expect(release).toHaveBeenCalled();
  });

  it('passes the failure through, so the dispatcher still retries', async () => {
    const guard = new DedupeGuard(inner(transient), redis(true).redis);

    await expect(guard.process(job())).resolves.toMatchObject({
      ok: false,
      retryable: true,
    });
  });

  it('releases the key when the processor throws outright', async () => {
    const { redis: service, release } = redis(true);

    await expect(
      new DedupeGuard(inner('throw'), service).process(job()),
    ).rejects.toThrow('processor exploded');

    // The job did not complete, so a later delivery has to be allowed to try.
    expect(release).toHaveBeenCalled();
  });
});

describe('DedupeGuard on a cancelled job', () => {
  const cancelled: JobResult = {
    ok: false,
    cancelled: true,
    error: 'stopped on request',
    retryable: false,
  };

  it('releases the key, so the work can be run again', async () => {
    const { redis: service, release } = redis(true);

    await new DedupeGuard(inner(cancelled), service).process(job());

    // The work was not done. Holding the key would skip the next attempt, which
    // is the opposite of what cancelling a job should mean.
    expect(release).toHaveBeenCalled();
  });
});

describe('DedupeGuard when redis is unavailable', () => {
  it('runs the work anyway, because a lost email is worse than a duplicate', async () => {
    const processor = inner(ok);

    await new DedupeGuard(processor, redis(null).redis).process(job());

    expect(processor.calls).toHaveLength(1);
  });

  it('does not release anything, since it never claimed anything', async () => {
    const { redis: service, release } = redis(null);

    await new DedupeGuard(inner(transient), service).process(job());

    expect(release).not.toHaveBeenCalled();
  });
});

describe('DedupeGuard without a dedupe key', () => {
  it('runs the work unguarded, so a job that wants every run gets it', async () => {
    const processor = inner(ok);
    const { redis: service, setIfAbsent } = redis(true);

    await new DedupeGuard(processor, service).process(
      job({ dedupeKey: undefined }),
    );

    expect(processor.calls).toHaveLength(1);
    expect(setIfAbsent).not.toHaveBeenCalled();
  });

  it('treats an empty key as absent rather than claiming the same key for all', async () => {
    const processor = inner(ok);
    const { redis: service, setIfAbsent } = redis(true);

    await new DedupeGuard(processor, service).process(job({ dedupeKey: '' }));

    expect(setIfAbsent).not.toHaveBeenCalled();
  });
});
