import { ExecutionContext } from '@nestjs/common';

import { beforeEach, describe, expect, it } from 'vitest';

import { throttlerConfig } from '../../configs/throttler.config.js';
import {
  RATE_LIMIT_METADATA,
  RateLimit,
} from '../decorators/rate-limit.decorator.js';
import {
  LOGIN_EMAIL_BUCKET,
  LOGIN_IP_BUCKET,
  MAIL_EMAIL_BUCKET,
  REFRESH_BUCKET,
} from '../constants/token.constants.js';
import { ThrottleByEmailGuard } from './throttle-by-email.guard.js';

/**
 * The guard loops over the buckets the *module* was given and nothing else, so a
 * bucket declared only in `@Throttle()` metadata is never reached. That is not
 * hypothetical: the per-address mail limit from Phase 14 was declared that way
 * and had never run.
 *
 * These tests reproduce the guard's own loop rather than asserting on the config
 * shape, so a bucket moving out of the module options fails here instead of
 * silently not enforcing anything in production.
 */

/**
 * The guard with the fields `onModuleInit` would fill in from DI.
 *
 * Constructed directly rather than through a Nest container: what is under test
 * is which buckets the module handed it and how it keys them, and standing up the
 * whole container to answer that would test the container.
 */
function guard(): ThrottleByEmailGuard {
  const options = throttlerConfig();

  if (Array.isArray(options)) {
    throw new Error('expected the object form');
  }

  const storage = {
    increment: async () => ({
      totalHits: 0,
      timeToExpire: 0,
      isBlocked: false,
      timeToBlockExpire: 0,
    }),
  };
  const reflector = {
    getAllAndOverride: () => undefined,
    get: () => undefined,
  };

  const instance = new ThrottleByEmailGuard(
    options,
    storage as never,
    reflector as never,
  );

  Reflect.set(instance, 'options', options);
  Reflect.set(instance, 'throttlers', options.throttlers);
  Reflect.set(instance, 'reflector', reflector);

  return instance;
}

/** The guard's own selection, reimplemented from its canActivate loop. */
function bucketsFor(handler: object): string[] {
  const options = throttlerConfig();

  if (Array.isArray(options)) {
    return [];
  }

  return options.throttlers
    .filter((bucket) => {
      const skipIf = bucket.skipIf as unknown as
        ((context: ExecutionContext) => boolean) | undefined;

      return (
        skipIf?.({
          getHandler: () => handler,
          getClass: () => class {},
        } as never) !== true
      );
    })
    .map((bucket) => bucket.name ?? 'default');
}

describe('which buckets apply to a route', () => {
  it('gives an unmarked route the default bucket and nothing else', () => {
    // Every other endpoint in the application. If a login or mail bucket landed
    // here, three mail requests would lock a user out of reading their profile.
    expect(bucketsFor(class {})).toEqual(['default']);
  });

  it('gives a login route both login buckets', () => {
    class Handler {}
    RateLimit('login')(Handler);

    const names = bucketsFor(Handler);

    expect(names).toContain(LOGIN_IP_BUCKET);
    expect(names).toContain(LOGIN_EMAIL_BUCKET);
  });

  it('keeps the mail bucket off a login route', () => {
    class Handler {}
    RateLimit('login')(Handler);

    expect(bucketsFor(Handler)).not.toContain(MAIL_EMAIL_BUCKET);
  });

  it('gives a mail route the per-address bucket, which used to never run', () => {
    class Handler {}
    RateLimit('mail')(Handler);

    expect(bucketsFor(Handler)).toContain(MAIL_EMAIL_BUCKET);
  });

  it('gives a refresh route only its own bucket', () => {
    class Handler {}
    RateLimit('refresh')(Handler);

    const names = bucketsFor(Handler);

    expect(names).toContain(REFRESH_BUCKET);
    expect(names).not.toContain(LOGIN_EMAIL_BUCKET);
    expect(names).not.toContain(LOGIN_IP_BUCKET);
  });

  it('never applies two groups to one route', () => {
    class Handler {}
    RateLimit('login')(Handler);

    expect(bucketsFor(Handler)).not.toContain(REFRESH_BUCKET);
  });
});

describe('ThrottleByEmailGuard keying', () => {
  let instance: ThrottleByEmailGuard;

  beforeEach(() => {
    instance = guard();
  });

  const generateKey = (name: string, body: unknown): string => {
    const context = {
      getHandler: () => class {},
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => ({ body }) }),
    } as unknown as ExecutionContext;

    return (
      instance as unknown as {
        generateKey(c: ExecutionContext, suffix: string, name: string): string;
      }
    ).generateKey(context, 'suffix', name);
  };

  it('keys the login bucket on the submitted address', () => {
    // The key is a hash, not the address, so what is asserted is that two
    // different addresses produce two different keys. A key that ignored the
    // address would give every account one shared budget, which is the opposite
    // of the limit.
    const first = generateKey(LOGIN_EMAIL_BUCKET, { email: 'a@x.com' });
    const second = generateKey(LOGIN_EMAIL_BUCKET, { email: 'b@x.com' });

    expect(first).not.toBe(second);
  });

  it('keys the mail bucket on the submitted address too', () => {
    const first = generateKey(MAIL_EMAIL_BUCKET, { email: 'a@x.com' });
    const second = generateKey(MAIL_EMAIL_BUCKET, { email: 'b@x.com' });

    expect(first).not.toBe(second);
  });

  it('separates the two email buckets from each other', () => {
    // Same address, different bucket: they must not share a counter, or the
    // stricter one governs both.
    expect(generateKey(LOGIN_EMAIL_BUCKET, { email: 'a@x.com' })).not.toBe(
      generateKey(MAIL_EMAIL_BUCKET, { email: 'a@x.com' }),
    );
  });

  it('normalises the address, so two spellings share one budget', () => {
    const upper = generateKey(LOGIN_EMAIL_BUCKET, { email: 'A@X.com' });
    const lower = generateKey(LOGIN_EMAIL_BUCKET, { email: 'a@x.com' });
    const padded = generateKey(LOGIN_EMAIL_BUCKET, { email: '  a@x.com  ' });

    // Otherwise an attacker doubles the budget by changing case per attempt.
    expect(upper).toBe(lower);
    expect(padded).toBe(lower);
  });

  it('leaves a per-client bucket keyed on the client, not the address', () => {
    // The login buckets are two limits, not one limit and one duplicate. If this
    // one also keyed on the address, the per-client limit would be useless
    // against the exact attack it exists for: rotating addresses.
    const first = generateKey(LOGIN_IP_BUCKET, { email: 'a@x.com' });
    const second = generateKey(LOGIN_IP_BUCKET, { email: 'b@x.com' });

    expect(first).toBe(second);
  });

  it('falls back to the client when no address was submitted', () => {
    // Nothing to key on, so the per-client tracker answers, and the per-client
    // bucket is what catches the request. `{}` and a missing body are the same
    // case and deliberately land on the same key; what must differ is that case
    // against a real address.
    expect(generateKey(LOGIN_EMAIL_BUCKET, {})).toBe(
      generateKey(LOGIN_EMAIL_BUCKET, null),
    );
    expect(generateKey(LOGIN_EMAIL_BUCKET, {})).not.toBe(
      generateKey(LOGIN_EMAIL_BUCKET, { email: 'a@x.com' }),
    );
  });

  it('treats a blank address as no address', () => {
    // An empty string is not a mailbox, and keying on it would put every caller
    // who sent one into a single shared bucket.
    expect(generateKey(LOGIN_EMAIL_BUCKET, { email: '   ' })).toBe(
      generateKey(LOGIN_EMAIL_BUCKET, {}),
    );
  });

  it('leaves the default bucket keyed on the client', () => {
    expect(generateKey('default', { email: 'a@x.com' })).toBe(
      generateKey('default', { email: 'b@x.com' }),
    );
  });
});

describe('the metadata key', () => {
  it('is the one the decorator writes and the skipIf reads', () => {
    class Handler {}
    RateLimit('login')(Handler);

    expect(Reflect.getMetadata(RATE_LIMIT_METADATA, Handler)).toBe('login');
  });
});
