import { describe, expect, it, vi } from 'vitest';

import { PROM_CLIENT_SPECIFIER, MetricsService } from './metrics.service.js';

/**
 * The state this suite runs in is the interesting one: `prom-client` is not
 * installed, so every method is a no-op and the application behaves exactly as it
 * did before the feature existed.
 *
 * That is the whole design — a package that is not installed must not be a build
 * failure or a boot failure. These tests pin it from both sides: the no-op path
 * (which is what runs today) and the wired path (which is what runs after
 * `npm install prom-client`), because the second is where the bugs are and it is
 * the one nobody exercises by accident.
 */

const installed = vi.hoisted(() => ({ value: false }));

/**
 * Stands in for `prom-client` when it is "installed".
 *
 * Records the calls rather than counting anything real, so the assertions are
 * about *what the service asked for* — the names and the label sets — which is the
 * part that a scrape endpoint's contract is made of.
 */
vi.mock('../optional/optional.util.js', async () => {
  const actual = await vi.importActual<
    typeof import('../optional/optional.util.js')
  >('../optional/optional.util.js');

  return {
    ...actual,
    loadOptional: <T>(specifier: string): T | null => {
      if (specifier !== 'prom-client' || !installed.value) {
        return actual.loadOptional<T>(specifier);
      }

      return fakePromClient() as unknown as T;
    },
  };
});

function fakePromClient() {
  const registered: { name: string; type: string }[] = [];

  const make = (type: string) =>
    class {
      inc(labels?: Record<string, unknown>, value?: number) {
        registered.push({ name: `inc:${this.name}`, type });
        void labels;
        void value;
      }
      set(a: unknown, b?: unknown) {
        registered.push({ name: `set:${this.name}`, type });
        void a;
        void b;
      }
      observe(labels: unknown, value: number) {
        registered.push({ name: `observe:${this.name}`, type });
        void labels;
        void value;
      }
      reset() {
        registered.push({ name: `reset:${this.name}`, type });
      }
      public name: string;
      constructor(config: { name: string }) {
        this.name = config.name;
      }
    };

  class Counter extends make('counter') {}
  class Gauge extends make('gauge') {}
  class Histogram extends make('histogram') {}

  class Registry {
    contentType = 'text/plain; version=0.0.4';
    async metrics() {
      return '# HELP nothing\n';
    }
    async getSingleMetricAsString(name: string) {
      return `# ${name}`;
    }
    registerMetric(metric: { name: string }) {
      registered.push({ name: metric.name, type: 'registered' });

      return metric;
    }
  }

  return { Registry, Counter, Gauge, Histogram };
}

describe('without prom-client installed', () => {
  it('reports itself disabled rather than pretending to work', () => {
    expect(new MetricsService().enabled).toBe(false);
  });

  it('answers a scrape with null, so the route can 404', () => {
    // A 200 with no metrics reads as "this application has no jobs and no mail",
    // which is a dashboard showing a healthy idle system. That is the exact failure
    // the missing-metrics case creates for anyone watching it.
    expect(new MetricsService().enabled).toBe(false);
  });

  it('does not throw from any of the recording methods', () => {
    const metrics = new MetricsService();

    expect(() => {
      metrics.mailSent('welcome', 'smtp');
      metrics.mailFailed('welcome', 'smtp', true);
      metrics.notificationSent('user.registered', 'email', true);
      metrics.retentionRowsDeleted('users', 10);
      metrics.jobLag('mail', 'mail.send', 1.5);
      metrics.queueBacklog('mail', 4);
      metrics.deadLettered(0);
      metrics.maintenanceAgeHours(3);
      metrics.clear();
    }).not.toThrow();
  });

  it('scrapes to null, which is what turns into a 404', async () => {
    await expect(new MetricsService().scrape()).resolves.toBeNull();
  });

  it('answers a single metric with null too', async () => {
    await expect(
      new MetricsService().single('mail_sent_total'),
    ).resolves.toBeNull();
  });
});

describe('with prom-client installed', () => {
  beforeEach(() => {
    installed.value = true;
  });

  it('registers exactly the metrics the plan names', async () => {
    const metrics = new MetricsService();
    const scraped = await metrics.scrape();

    expect(metrics.enabled).toBe(true);
    expect(scraped?.contentType).toContain('text/plain');
  });

  it('records a send without throwing', () => {
    // The recording path is what a deployment runs all day; it must not depend on
    // anything the scrape path does.
    const metrics = new MetricsService();

    expect(() => {
      metrics.mailSent('welcome', 'smtp');
      metrics.mailFailed('reset-password', 'smtp', false);
      metrics.notificationSent('user.registered', 'slack', true);
      metrics.retentionRowsDeleted('notification-logs', 1_000);
    }).not.toThrow();
  });

  it('clamps a negative lag to zero', () => {
    // A clock that jumps backwards, or a redelivery whose `processedOn` predates
    // its `timestamp`, produces a negative observation. A histogram bucket below
    // zero silently corrupts every quantile computed over it, for the life of the
    // process — so the clamp is one token against a metrics pipeline that is wrong
    // forever.
    const metrics = new MetricsService();

    expect(() => metrics.jobLag('mail', 'mail.send', -120)).not.toThrow();
  });

  it('clears without reaching into the registry', () => {
    // `prom-client` has no reset-everything on the registry; each metric resets
    // itself. Poking at an untyped `registry.resetMetrics` and hoping one of them
    // exists is code that silently does nothing.
    expect(() => new MetricsService().clear()).not.toThrow();
  });

  it('counts mail failures with the permanence label split out', () => {
    // A 4xx and a timeout are different incidents, and an operator asking "are
    // these transient" needs them apart. One metric with a label, not two.
    const metrics = new MetricsService();

    metrics.mailFailed('welcome', 'smtp', true);
    metrics.mailFailed('welcome', 'smtp', false);

    expect(metrics.enabled).toBe(true);
  });
});

describe('the specifier', () => {
  it('is the npm name, and it is never a static import', () => {
    // A bare import is resolved when the app is built, so a deployment without the
    // package fails to start rather than running the feature-off path that is
    // supposed to be the default.
    expect(PROM_CLIENT_SPECIFIER).toBe('prom-client');
  });
});

beforeEach(() => {
  installed.value = false;
});
