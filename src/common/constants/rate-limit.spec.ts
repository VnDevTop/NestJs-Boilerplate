import { ExecutionContext } from '@nestjs/common';

import { describe, expect, it } from 'vitest';

import {
  AUTH_THROTTLE,
  LOGIN_EMAIL_BUCKET,
  LOGIN_IP_BUCKET,
  MAIL_EMAIL_BUCKET,
  REFRESH_BUCKET,
} from './token.constants.js';
import { throttlerConfig } from '../../configs/throttler.config.js';
import {
  RATE_LIMIT_METADATA,
  RateLimit,
  rateLimitApplies,
} from '../decorators/rate-limit.decorator.js';

function contextFor(handler: object): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

/**
 * The buckets as the throttler module actually receives them.
 *
 * `ThrottlerModuleOptions` is the array form or the object form, and only the
 * object form carries `throttlers`, so the union is narrowed rather than indexed.
 */
function buckets() {
  const options = throttlerConfig();

  if (Array.isArray(options)) {
    throw new Error('expected the object form of the throttler options');
  }

  // `limit` and `ttl` are resolvable, so they are functions in the type. This
  // config always supplies numbers; the cast says that and nothing more.
  return options.throttlers as unknown as {
    name?: string;
    limit: number;
    ttl: number;
    blockDuration?: number;
    skipIf?: (context: never) => boolean;
  }[];
}

/** One bucket, by name. */
function bucket(name: string) {
  const found = buckets().find((entry) => entry.name === name);

  if (!found) {
    throw new Error(`no bucket named ${name}`);
  }

  return found;
}

describe('the auth rate limit groups', () => {
  it('declares every bucket in the module, because the guard reads only those', () => {
    // The guard builds its list from the module options and nothing else, so a
    // bucket missing here is a bucket that never runs.
    const names = buckets().map((entry) => entry.name);

    expect(names).toEqual(
      expect.arrayContaining([
        LOGIN_IP_BUCKET,
        LOGIN_EMAIL_BUCKET,
        REFRESH_BUCKET,
      ]),
    );
  });

  describe('login, per client address', () => {
    it('allows twenty per five minutes', () => {
      expect(bucket(LOGIN_IP_BUCKET).limit).toBe(20);
      expect(bucket(LOGIN_IP_BUCKET).ttl).toBe(5 * 60 * 1000);
    });
  });

  describe('login, per submitted address', () => {
    it('allows ten per five minutes', () => {
      // Tighter than the per-client limit because the target is one account's
      // password: an attacker guessing one account wants few attempts against
      // that account, not many against many.
      expect(bucket(LOGIN_EMAIL_BUCKET).limit).toBe(10);
    });

    it('is the tighter of the two', () => {
      expect(bucket(LOGIN_EMAIL_BUCKET).limit).toBeLessThan(
        bucket(LOGIN_IP_BUCKET).limit,
      );
    });
  });

  describe('the block once a bucket is exceeded', () => {
    it('lasts the whole window on login, so the limit is a delay', () => {
      // Without a block the caller simply waits out the window and continues at
      // full speed, which is the same as no limit at all in aggregate.
      expect(bucket(LOGIN_IP_BUCKET).blockDuration).toBe(
        AUTH_THROTTLE.windowMs,
      );
      expect(bucket(LOGIN_EMAIL_BUCKET).blockDuration).toBe(
        AUTH_THROTTLE.windowMs,
      );
    });
  });

  describe('refresh', () => {
    it('allows sixty per minute, because every page load uses one', () => {
      expect(bucket(REFRESH_BUCKET).limit).toBe(60);
      expect(bucket(REFRESH_BUCKET).ttl).toBe(60 * 1000);
    });

    it('is the only bucket on that route', () => {
      // A refresh carries no address, so a per-address bucket would fall back to
      // the client and duplicate the per-client one.
      const applies = bucket(REFRESH_BUCKET).skipIf as unknown as (
        context: unknown,
      ) => boolean;
      const handler = class {};
      const context = { getHandler: () => handler, getClass: () => class {} };

      expect(applies(context as never)).toBe(true);
    });
  });

  describe('skipping', () => {
    const skip = (name: string, handler: object): boolean => {
      const applies = bucket(name).skipIf as unknown as (
        context: unknown,
      ) => boolean;

      return applies({
        getHandler: () => handler,
        getClass: () => class {},
      } as never);
    };

    it('skips a bucket on a route that never opted in', () => {
      // The reason this exists: a globally declared bucket lands on every
      // endpoint unless it says otherwise.
      expect(skip(LOGIN_IP_BUCKET, class {})).toBe(true);
    });

    it('runs a bucket on a route that opted into its group', () => {
      class Handler {}
      RateLimit('login')(Handler);

      expect(skip(LOGIN_IP_BUCKET, Handler)).toBe(false);
    });

    it('keeps the mail bucket off a login route', () => {
      // The failure this prevents: a three-per-hour mail limit landing on
      // `POST /login`, which would lock out a real user after three tries.
      class Handler {}
      RateLimit('login')(Handler);

      expect(skip(MAIL_EMAIL_BUCKET, Handler)).toBe(true);
    });
  });
});

describe('@RateLimit', () => {
  it('marks a handler with its group', () => {
    class Handler {}
    RateLimit('login')(Handler);

    expect(Reflect.getMetadata(RATE_LIMIT_METADATA, Handler)).toBe('login');
  });

  it('applies to a handler that opted into that group', () => {
    class Handler {}
    RateLimit('login')(Handler);

    expect(rateLimitApplies(contextFor(Handler), ['login'])).toBe(true);
  });

  it('does not apply to a handler in a different group', () => {
    class Handler {}
    RateLimit('refresh')(Handler);

    // The whole reason for groups: a refresh marker must not turn on the login
    // buckets, or every refresh would be throttled as a login attempt.
    expect(rateLimitApplies(contextFor(Handler), ['login'])).toBe(false);
    expect(rateLimitApplies(contextFor(Handler), ['refresh'])).toBe(true);
  });

  it('does not apply to a handler with no marker at all', () => {
    class Handler {}

    // Without this a globally declared bucket would land on every endpoint in
    // the application, which is how a three-per-hour mail limit ends up on
    // `GET /users`.
    expect(rateLimitApplies(contextFor(Handler), ['login'])).toBe(false);
    expect(rateLimitApplies(contextFor(Handler), ['mail'])).toBe(false);
  });

  it('treats an empty group list as nothing applying', () => {
    class Handler {}
    RateLimit('login')(Handler);

    expect(rateLimitApplies(contextFor(Handler), [])).toBe(false);
  });
});
