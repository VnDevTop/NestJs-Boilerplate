import { describe, expect, it, vi } from 'vitest';

import { SENTRY_SPECIFIER, SentryService } from './sentry.service.js';
import { appVersion } from './sentry-release.js';

/**
 * Builds a service with `SENTRY_DSN` set to `dsn`, restoring it afterwards.
 *
 * The DSN is an environment variable rather than a constructor argument now, and
 * that change is not cosmetic: a constructor parameter typed `string | undefined`
 * is an injection token to Nest, so a deployment with a DSN set could not boot.
 * Reading it from the environment in the constructor is what keeps the injector
 * out of it, and this helper is what keeps the tests able to say which DSN a
 * service was built with.
 */
function withDsn<T>(dsn: string | undefined, build: () => T): T {
  const previous = process.env['SENTRY_DSN'];

  if (dsn === undefined) {
    delete process.env['SENTRY_DSN'];
  } else {
    process.env['SENTRY_DSN'] = dsn;
  }

  try {
    return build();
  } finally {
    if (previous === undefined) {
      delete process.env['SENTRY_DSN'];
    } else {
      process.env['SENTRY_DSN'] = previous;
    }
  }
}

const DSN = 'https://key@o0.ingest.sentry.io/0';

/**
 * What matters here is the **scrubbing**, not the reporting.
 *
 * Sentry's default integrations attach the request headers, the cookies and the
 * body to every event. Those are exactly where a password, a reset token and a
 * two-factor code arrive — an error reporting service holding a sign-up body is a
 * credential store with a far larger blast radius than the database, because it is
 * a third party with a different retention policy and a different jurisdiction.
 *
 * So the tests are mostly about what does **not** leave.
 */

const installed = vi.hoisted(() => ({ value: false }));
const captured: { error: unknown; hint: unknown }[] = [];
const initOptions: Record<string, unknown>[] = [];

vi.mock('../optional/optional.util.js', async () => {
  const actual = await vi.importActual<
    typeof import('../optional/optional.util.js')
  >('../optional/optional.util.js');

  return {
    ...actual,
    loadOptional: <T>(specifier: string): T | null => {
      if (specifier !== '@sentry/node' || !installed.value) {
        return actual.loadOptional<T>(specifier);
      }

      return fakeSdk() as unknown as T;
    },
  };
});

function fakeSdk() {
  return {
    init: (options: Record<string, unknown>) => initOptions.push(options),
    captureException: (error: unknown, hint: unknown) => {
      captured.push({ error, hint });

      return 'event-1';
    },
    captureMessage: () => 'event-2',
    addBreadcrumb: () => undefined,
    flush: async () => true,
  };
}

/** The `beforeSend` Sentry was configured with, run against one event. */
function scrub(event: Record<string, unknown>): Record<string, unknown> {
  const beforeSend = initOptions.at(-1)?.['beforeSend'] as (
    value: Record<string, unknown>,
  ) => Record<string, unknown>;

  return beforeSend(event);
}

describe('without the SDK installed', () => {
  it('is disabled, and says so rather than pretending', () => {
    expect(withDsn(undefined, () => new SentryService()).enabled).toBe(false);
  });

  it('accepts every call without throwing', async () => {
    // This is called from an exception filter, which is the last place a process is
    // still running. An error reporter that throws turns a handled 500 into a dead
    // process.
    const sentry = withDsn(undefined, () => new SentryService());

    expect(() => sentry.captureException(new Error('x'))).not.toThrow();
    expect(() => sentry.captureMessage('x')).not.toThrow();
    expect(() => sentry.addBreadcrumb('x')).not.toThrow();
    await expect(sentry.flush()).resolves.toBeUndefined();
  });
});

describe('with a DSN but no SDK', () => {
  it('stays disabled, because a DSN sends nothing on its own', () => {
    // Worth distinguishing from "installed but no DSN": this is a half-configured
    // deployment, and it is the one somebody will believe is reporting errors.
    expect(withDsn(DSN, () => new SentryService()).enabled).toBe(false);
  });
});

describe('with the SDK and a DSN', () => {
  beforeEach(() => {
    installed.value = true;
    initOptions.length = 0;
    captured.length = 0;
  });

  it('is enabled', () => {
    expect(withDsn(DSN, () => new SentryService()).enabled).toBe(true);
  });

  it('reports an exception', () => {
    const sentry = withDsn(DSN, () => new SentryService());

    sentry.captureException(new Error('boom'), { requestId: 'req-1' });

    const first = captured[0] as { error: unknown; hint: unknown };

    expect(captured).toHaveLength(1);
    expect((first.error as Error).message).toBe('boom');
  });

  it('never throws, whatever the SDK does', () => {
    // The SDK is a third party reached over the network, from a catch block.
    const exploding = withDsn(DSN, () => new SentryService());

    vi.spyOn(
      exploding as unknown as { sentry: { captureException: unknown } },
      'sentry',
      'get',
    ).mockReturnValue({
      captureException: () => {
        throw new Error('the transport is down');
      },
    });

    expect(() => exploding.captureException(new Error('x'))).not.toThrow();
  });
});

describe('what leaves the process', () => {
  beforeEach(() => {
    installed.value = true;
    initOptions.length = 0;
    // Constructed here rather than in each test: `beforeSend` is a closure the
    // constructor hands Sentry, so there is nothing to call until one exists.
    withDsn(DSN, () => new SentryService());
  });

  it('never sends the request headers, which is where an auth header lives', () => {
    const scrubbed = scrub({
      request: {
        headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9' },
        cookies: 'session=abc',
        data: { password: 'hunter2', email: 'a@x.com' },
        url: 'https://api.x.com/auth/register',
      },
    });

    const request = scrubbed['request'] as Record<string, unknown>;

    expect(request['headers']).toBeUndefined();
    expect(request['cookies']).toBeUndefined();
    expect(request['data']).toBeUndefined();
  });

  it('drops the query string, because that is where a single-use link lives', () => {
    // `?token=` is a reset, verification or unlock link. It works exactly once and
    // for whoever holds it, which is nobody who should be reading an error report.
    const scrubbed = scrub({
      request: {
        url: 'https://api.x.com/auth/reset?token=abc123def456&email=a@x.com',
      },
    });

    expect((scrubbed['request'] as { url: string }).url).toBe(
      'https://api.x.com/auth/reset',
    );
  });

  it('drops the extras this application would otherwise attach', () => {
    const scrubbed = scrub({
      extra: {
        body: { password: 'x' },
        password: 'y',
        token: 'z',
        route: 'ok',
      },
    });

    const extra = scrubbed['extra'] as Record<string, unknown>;

    expect(extra['body']).toBeUndefined();
    expect(extra['password']).toBeUndefined();
    expect(extra['token']).toBeUndefined();
    expect(extra['route']).toBe('ok');
  });

  it('keeps the breadcrumbs, because they are what makes an error explainable', () => {
    // "This failed after the notification to Slack" is the difference between a bug
    // report and a puzzle. They carry no request body, which is why they stay.
    const event = {
      breadcrumbs: [{ category: 'app', message: 'notification sent' }],
      request: { headers: { authorization: 'Bearer x' } },
    };

    expect(scrub(event)['breadcrumbs']).toHaveLength(1);
  });

  it('survives an event with no request at all', () => {
    // A job that throws outside a request is the case most likely to reach here
    // first, and it has no `request` key to delete from.
    expect(() => scrub({ message: 'a queue processor failed' })).not.toThrow();
  });
});

describe('the release tag', () => {
  beforeEach(() => {
    installed.value = true;
    initOptions.length = 0;
  });

  it('falls back to the package version', () => {
    // Without a release, Sentry cannot tell a regression from the deploy that
    // introduced it, and its issue list is a wall of "new since Tuesday".
    delete process.env['SENTRY_RELEASE'];

    withDsn(DSN, () => new SentryService());

    expect(initOptions[0]?.['release']).toBe(appVersion());
  });

  it('prefers the environment value, which CI sets from the git SHA', () => {
    process.env['SENTRY_RELEASE'] = 'abc1234';

    withDsn(DSN, () => new SentryService());

    expect(initOptions[0]?.['release']).toBe('abc1234');

    delete process.env['SENTRY_RELEASE'];
  });

  it('disables performance tracing, because spans already go to OpenTelemetry', () => {
    // Running one request through two tracing systems doubles the cost and splits
    // the trace in two, so exactly one of them should be on.
    withDsn(DSN, () => new SentryService());

    expect(initOptions[0]?.['tracesSampleRate']).toBe(0);
  });

  it('reads the version without a compiler setting or an emitted JSON asset', () => {
    // `import pkg from '../package.json'` needs `resolveJsonModule` and drags the
    // file through the build for one string.
    expect(appVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('the specifier', () => {
  it('is a string, never a static import', () => {
    expect(SENTRY_SPECIFIER).toBe('@sentry/node');
  });
});

beforeEach(() => {
  installed.value = false;
});
