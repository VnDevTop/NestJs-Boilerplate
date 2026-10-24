import { createHash } from 'node:crypto';

import { Logger } from '@nestjs/common';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';

import {
  PREFIX_LENGTH,
  PasswordBreachService,
} from './password-breach.service.js';

/**
 * The breach check sits in a signup path, so its failure behaviour is the part
 * worth defending: an unreachable third party must not be able to stop anybody
 * registering, and a 429 must not take a form down.
 *
 * The cache is a real one with a `Map`, because "the answer is cached" is a claim
 * about the second call not reaching the network, and a mock can only assert that
 * `wrap` was called.
 */

interface Harness {
  service: PasswordBreachService;
  get: ReturnType<typeof vi.fn>;
  /** Prefixes the service asked the API about, i.e. network round trips. */
  requests: string[];
  /** The TTL each cached entry was written under, in seconds, in write order. */
  ttls: number[];
  /**
   * Everything the service logged, read once.
   *
   * Restores the spy on read, so calling it twice returns an empty string the
   * second time. Deliberately: a second call that re-read the spy would hide the
   * fact that it had been restored.
   */
  logs: () => string;
  /** The fake cache's contents, so a test can age an entry out. */
  expire: () => void;
}

function harness(
  respond: (url: string) => { status: number; data: string } | Error,
): Harness {
  const requests: string[] = [];
  const store = new Map<string, unknown>();
  /** The TTL each entry was written under, in seconds, in write order. */
  const ttls: number[] = [];

  // An observable, not a promise, because `HttpService.get` returns one and the
  // service unwraps it with `firstValueFrom`. A promise double fails open with
  // "source.subscribe is not a function", which reads as a passing breach check.
  const get = vi.fn((url: string) => {
    requests.push(url);

    const answer = respond(url);

    return answer instanceof Error ? throwError(() => answer) : of(answer);
  });

  const cache = {
    // Models the real `CacheService.wrap`, recording the TTL each value was stored
    // under rather than only whether it was stored. The distinction between "not
    // breached" and "could not check" is carried entirely by which TTL was used, so
    // a double that only remembered the hits would hide the thing under test.
    wrap: async <T>(
      key: string,
      loader: () => Promise<T>,
      options: { ttl?: number; emptyTtl?: number } = {},
    ): Promise<T> => {
      if (store.has(key)) {
        return store.get(key) as T;
      }

      const value = await loader();
      const nullish = value === null || value === undefined;

      store.set(key, value);
      ttls.push(nullish ? (options.emptyTtl ?? 0) : (options.ttl ?? 0));

      return value;
    },
  };

  const logged: string[] = [];
  const warn = vi
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation((message: unknown) => {
      logged.push(String(message));
    });

  const service = new PasswordBreachService({ get } as never, cache as never);

  return {
    service,
    get,
    requests,
    ttls,
    logs: () => {
      warn.mockRestore();

      return logged.join('\n');
    },
    expire: () => store.clear(),
  };
}

/**
 * The digest of `password`, split the way the service splits it.
 *
 * Written out rather than computed by the helper under test, so a change to the
 * helper cannot quietly change what this file is asserting. Computed once with
 * `node:crypto` and pasted.
 */
const PASSWORD_PREFIX = '5BAA6';
const PASSWORD_SUFFIX = '1E4C9B93F3F0682250B6CF8331B7EE68FD8';

/** A response whose bucket contains `suffix`, so the lookup finds it. */
const containing = (suffix: string) => ({
  status: 200,
  data: ['0018A45C4D1DEF81644B54AB7F969B88D65:1', `${suffix}:42`].join('\r\n'),
});

/** The path the service asked about, without the host. */
const pathOf = (url: string): string => url.slice(url.lastIndexOf('/') + 1);

/**
 * A bucket that contains `password`, built with node's own sha1 rather than the
 * service's helper.
 *
 * Deriving it here means a test can use any password and still be answered
 * correctly. A hard-coded suffix silently stops matching the moment the test's
 * password changes, and the lookup then reports "not breached" — which is the
 * one answer a breach test must never accept by accident.
 */
const bucketFor = (password: string) => {
  const digest = createHash('sha1')
    .update(password, 'utf8')
    .digest('hex')
    .toUpperCase();

  return containing(digest.slice(PREFIX_LENGTH));
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a lookup', () => {
  it('sends only the prefix, so the service never learns the password', async () => {
    // The property that justifies the whole approach. A request carrying the digest
    // in full would hand a third party a brute-forceable hash of every password a
    // user tried.
    const h = harness(() => containing(PASSWORD_SUFFIX));

    await h.service.isBreached('password');

    expect(pathOf(h.requests[0])).toBe(PASSWORD_PREFIX);
    expect(pathOf(h.requests[0])).toHaveLength(5);
  });

  it('never puts the password or the whole digest in the url', async () => {
    const h = harness(() => containing(PASSWORD_SUFFIX));

    await h.service.isBreached('password');

    // The path only, because the host itself contains the word: a substring check
    // against the full url would pass on the digest and fail on `pwnedpasswords`.
    expect(pathOf(h.requests[0])).not.toBe(PASSWORD_SUFFIX);
    expect(h.requests[0]).not.toContain(PASSWORD_SUFFIX);
  });

  it('asks over https, so the prefix is not sent in clear text', async () => {
    // Five hex characters is five hex characters of a digest, and the whole scheme
    // depends on the service not learning which password was asked about.
    const h = harness(() => containing(PASSWORD_SUFFIX));

    await h.service.isBreached('password');

    expect(h.requests[0].startsWith('https://')).toBe(true);
  });

  it('answers true when the returned bucket contains the suffix', async () => {
    const h = harness(() => containing(PASSWORD_SUFFIX));

    await expect(h.service.isBreached('password')).resolves.toBe(true);
  });

  it('answers false when the bucket does not', async () => {
    const h = harness(() => ({
      status: 200,
      data: '0018A45C4D1DEF81644B54AB7F969B88D65:1',
    }));

    await expect(h.service.isBreached('password')).resolves.toBe(false);
  });

  it('does not log the password, even when it refuses one', async () => {
    // A distinctive value, because the log line legitimately contains the English
    // word "password" and an assertion against that substring would pass on a line
    // that had leaked the value somewhere else.
    const h = harness(() => bucketFor('Tr0ub4dor-and-3'));

    await h.service.isBreached('Tr0ub4dor-and-3');

    const logged = h.logs();

    expect(logged).not.toContain('Tr0ub4dor-and-3');
    expect(logged).toContain('42');
  });

  it('does not pass a hand-set timeout, relying on shared client configuration', async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const get = vi.fn((_url: string, options?: Record<string, unknown>) => {
      capturedOptions = options;
      return of({ status: 200, data: '' });
    });
    const service = new PasswordBreachService(
      { get } as never,
      { wrap: async (_k: string, fn: () => Promise<unknown>) => fn() } as never,
    );

    await service.isBreached('password');

    expect(capturedOptions?.timeout).toBeUndefined();
  });
});

describe('caching', () => {
  it('asks the API once per password, however many times it is checked', async () => {
    // A breach is permanent, so the second check of the same password is pure cost.
    const h = harness(() => containing(PASSWORD_SUFFIX));

    await h.service.isBreached('password');
    await h.service.isBreached('password');
    await h.service.isBreached('password');

    expect(h.requests).toHaveLength(1);
  });

  it('remembers a clean verdict as well as a breach', async () => {
    // Caching only the positive answer would send every good password to the API
    // forever, which is both slow and exactly the traffic pattern that gets a
    // deployment rate-limited.
    const h = harness(() => ({
      status: 200,
      data: '0018A45C4D1DEF81644B54AB7F969B88D65:1',
    }));

    await h.service.isBreached('password');
    await h.service.isBreached('password');

    expect(h.requests).toHaveLength(1);
  });

  it('caches per password, so two users do not share a verdict', async () => {
    const h = harness((url) =>
      pathOf(url) === PASSWORD_PREFIX
        ? containing(PASSWORD_SUFFIX)
        : { status: 200, data: '0018A45C4D1DEF81644B54AB7F969B88D65:1' },
    );

    await expect(h.service.isBreached('password')).resolves.toBe(true);
    await expect(h.service.isBreached('a-longer-one')).resolves.toBe(false);
    expect(h.requests).toHaveLength(2);
  });

  it('keys on the hash, so the cache holds no plaintext', async () => {
    const keys: string[] = [];
    const store = new Map<string, unknown>();
    const service = new PasswordBreachService(
      { get: vi.fn(async () => ({ status: 200, data: '' })) } as never,
      {
        wrap: async <T>(key: string, loader: () => Promise<T>): Promise<T> => {
          keys.push(key);

          const value = await loader();

          store.set(key, value);

          return value;
        },
      } as never,
    );

    await service.isBreached('password');

    // A redis dump is a list of digests of passwords people chose, and digests are
    // brute-forceable. The key must not be the password.
    expect(keys[0]).not.toContain('password');
    expect(keys[0].replace('breach:', '')).toMatch(/^[0-9A-F]{40}$/);
  });
});

describe('when the service cannot be reached', () => {
  it('answers false rather than refusing, because a signup is not the place to fail closed', async () => {
    // A third party being slow would then be a way to lock every user out of this
    // deployment, which is an availability dependency dressed up as a security
    // control.
    const h = harness(() => new Error('ECONNREFUSED'));

    await expect(h.service.isBreached('password')).resolves.toBe(false);
  });

  it('says so, because a check that quietly stopped running is worse than one that is off', async () => {
    const h = harness(() => new Error('ECONNREFUSED'));

    await h.service.isBreached('password');

    expect(h.logs()).toContain('could not be reached');
  });

  it('says so when the service answers with an error status', async () => {
    // A 429 from the service is a fact to log, not an exception to unwind a signup
    // with. Reported with its status because "rate limited" and "gone" need
    // different responses from an operator.
    const h = harness(() => ({ status: 429, data: '' }));

    await expect(h.service.isBreached('password')).resolves.toBe(false);
    expect(h.logs()).toContain('429');
  });

  it('keeps a failed lookup for a minute, not for the verdict lifetime', async () => {
    // The distinction that matters is the TTL, not whether the failure is cached at
    // all. A twenty-four hour verdict is right for "not breached" and wrong for "we
    // could not ask": caching the failure for that long would leave every user on a
    // bad network unprotected for a day, which is longer than the outage that caused
    // it. A minute is short enough to recover and long enough not to hammer a
    // service that is already struggling.
    const h = harness(() => new Error('ECONNREFUSED'));

    await h.service.isBreached('password');

    expect(h.ttls).toHaveLength(1);
    expect(h.ttls[0]).toBeLessThan(300);
    expect(h.ttls[0]).toBeGreaterThan(0);
  });

  it('keeps a real verdict for much longer than a failure', async () => {
    // A breach is permanent, so the two answers must not share a lifetime.
    const clean = harness(() => ({
      status: 200,
      data: '0018A45C4D1DEF81644B54AB7F969B88D65:1',
    }));
    const broken = harness(() => new Error('ECONNREFUSED'));

    await clean.service.isBreached('password');
    await broken.service.isBreached('password');

    expect(clean.ttls[0]).toBeGreaterThan(broken.ttls[0] * 100);
  });

  it('re-asks once the short failure entry expires', async () => {
    // A failed answer that is never retried is a check that switched itself off
    // during the one outage it existed for.
    let failing = true;
    const h = harness(() =>
      failing ? new Error('ECONNREFUSED') : { status: 200, data: 'nothing' },
    );

    await h.service.isBreached('password');

    failing = false;
    // Cleared rather than aged: the entry is short-lived, and a test that waited a
    // minute to prove a TTL would prove nothing else in the meantime.
    h.expire();

    await expect(h.service.isBreached('password')).resolves.toBe(false);
    expect(h.requests).toHaveLength(2);
  });

  it('fails open on every status the service can answer with', async () => {
    for (const status of [400, 401, 403, 404, 500, 503]) {
      const h = harness(() => ({ status, data: '' }));

      await expect(h.service.isBreached('password')).resolves.toBe(false);
      h.logs();
    }
  });

  it('reads a non-string body as empty rather than throwing', async () => {
    // The transform is configured to hand back the raw text, but a proxy answering
    // with JSON would otherwise reach `body.split`.
    const h = harness(() => ({ status: 200, data: undefined as never }));

    await expect(h.service.isBreached('password')).resolves.toBe(false);
  });

  it('opens the circuit breaker after repeated failures and fails open without reaching the network', async () => {
    let calls = 0;
    const h = harness(() => {
      calls++;
      return new Error('ECONNREFUSED');
    });

    // Cause 5 consecutive failures to open the circuit breaker
    for (let i = 0; i < 5; i++) {
      h.expire();
      await h.service.isBreached(`password-${i}`);
    }

    expect(calls).toBe(5);
    expect(h.service.breaker.currentState).toBe('open');

    // 6th call should be rejected by the circuit breaker immediately without a network call
    h.expire();
    await expect(h.service.isBreached('password-6')).resolves.toBe(false);
    expect(calls).toBe(5);
    expect(h.logs()).toContain('Circuit breaker is open');
  });
});
