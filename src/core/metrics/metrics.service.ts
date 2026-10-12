import { Injectable, Logger } from '@nestjs/common';

import { loadOptional } from '../optional/optional.util.js';

/** The npm specifier, as a string, because it must never be a static import. */
export const PROM_CLIENT_SPECIFIER = 'prom-client';

/**
 * The subset of `prom-client` this module uses.
 *
 * Declared here rather than imported from the package, for the reason
 * `provider.types.ts` gives: a type-only `typeof import('prom-client')` is still
 * resolved by `tsc`, so a clone with no metrics package installed would fail to
 * typecheck — which is the build-time failure this project avoids.
 */
interface ResettableMetric {
  reset(): void;
}

interface PromCounter extends ResettableMetric {
  inc(labels?: Record<string, string | number>, value?: number): void;
}

interface PromGauge extends ResettableMetric {
  // Labels first, then the value, and the labels are optional for a gauge that has
  // none. That is prom-client's own order, and matching it matters: the reverse
  // compiles happily here and passes every test that never scrapes the endpoint,
  // then throws when Prometheus does.
  set(labels: Record<string, string | number>, value: number): void;
  set(value: number): void;
}

interface PromHistogram extends ResettableMetric {
  observe(labels: Record<string, string | number>, value: number): void;
}

interface PromRegistry {
  registerMetric(metric: unknown): unknown;
  metrics(): Promise<string>;
  contentType: string;
  getSingleMetricAsString(name: string): Promise<string>;
}

interface PromClient {
  Registry: new () => PromRegistry;
  Counter: new (config: {
    name: string;
    help: string;
    labelNames?: string[];
  }) => PromCounter;
  Gauge: new (config: {
    name: string;
    help: string;
    labelNames?: string[];
  }) => PromGauge;
  Histogram: new (config: {
    name: string;
    help: string;
    labelNames?: string[];
    buckets?: number[];
  }) => PromHistogram;
}

/**
 * Prometheus counters, or nothing at all when the package is absent.
 *
 * ## The absence of metrics is not an error
 *
 * `loadOptional` returns `null`, every method here returns without doing
 * anything, and the application runs exactly as it did before — just without a
 * `/metrics` endpoint. That is the same rule every other optional feature in this
 * project follows, and the reason is the same: the alternative is a package that
 * is not installed being a build failure or a boot failure, which turns a missing
 * convenience into a missing application.
 *
 * **There is no metric-registry health check on purpose.** A deployment that has
 * not installed `prom-client` is not broken, and reporting it as degraded would
 * page somebody about a feature nobody asked for. The way to find out is
 * `curl /metrics` returning 404, which is unambiguous.
 *
 * ## Why a dedicated registry
 *
 * The default global registry on `prom-client` is process-global, which makes it
 * impossible to reset between tests and leaks state between test files in the
 * same process. Owning the registry is what lets `clear()` exist, and that is what
 * makes the tests deterministic.
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);

  private readonly client: PromClient | null;
  private readonly registry: PromRegistry | null;

  /** The five metrics the plan names, plus the histograms they need. */
  private readonly counters: {
    mailSent: PromCounter | null;
    mailFailures: PromCounter | null;
    notificationSent: PromCounter | null;
    retentionRowsDeleted: PromCounter | null;
    loginAttempts: PromCounter | null;
  };

  private readonly gauges: {
    queueBacklog: PromGauge | null;
    deadLettered: PromGauge | null;
    maintenanceAgeHours: PromGauge | null;
  };

  private readonly histograms: {
    jobLag: PromHistogram | null;
  };

  /**
   * Every metric created, so `clear()` does not have to reach into the registry.
   *
   * `prom-client` does not expose a "reset everything" on the registry; each
   * metric resets itself. Poking at an untyped `registry.resetMetrics` and hoping
   * one of them exists is the kind of code that silently does nothing, so the
   * metrics are kept here instead — which is also why the registry is ours rather
   * than the process-global default.
   */
  private readonly created: ResettableMetric[] = [];

  constructor() {
    this.client = loadOptional<PromClient>(PROM_CLIENT_SPECIFIER);

    if (this.client === null) {
      this.logger.log(
        `Prometheus metrics are disabled. To enable them: ` +
          `npm install ${PROM_CLIENT_SPECIFIER}`,
      );

      this.registry = null;
      this.counters = {
        mailSent: null,
        mailFailures: null,
        notificationSent: null,
        retentionRowsDeleted: null,
        loginAttempts: null,
      };
      this.gauges = {
        queueBacklog: null,
        deadLettered: null,
        maintenanceAgeHours: null,
      };
      this.histograms = { jobLag: null };

      return;
    }

    this.registry = new this.client.Registry();

    // A bounded set of label values. An unbounded one — `template` and `email` —
    // is a memory leak that presents as a slow crawl, and the second of those is
    // a cardinality bomb: one series per address, forever.
    this.counters = {
      mailSent: this.counter(
        'mail_sent_total',
        'Mails accepted by the provider',
        ['template', 'transport'],
      ),
      mailFailures: this.counter(
        'mail_failures_total',
        'Mail sends that failed',
        ['template', 'transport', 'permanent'],
      ),
      notificationSent: this.counter(
        'notification_sent_total',
        'Notifications by delivery outcome',
        ['event', 'channel', 'delivered'],
      ),
      retentionRowsDeleted: this.counter(
        'retention_rows_deleted_total',
        'Rows the retention job deleted, by target',
        ['target'],
      ),
      loginAttempts: this.counter(
        'auth_login_attempts_total',
        'Sign-in attempts, by whether they succeeded',
        ['outcome'],
      ),
    };

    this.gauges = {
      queueBacklog: this.gauge('queue_backlog', 'Jobs waiting on a queue', [
        'queue',
      ]),
      deadLettered: this.gauge(
        'dead_lettered_total',
        'Jobs that exhausted their retries',
      ),
      maintenanceAgeHours: this.gauge(
        'maintenance_age_hours',
        'Hours since the last maintenance run finished',
      ),
    };

    this.histograms = {
      // Buckets chosen for a queue lag measured in seconds: sub-second is normal,
      // ten minutes is an incident. The log-friendly boundary in between is where
      // an alert on `histogram_quantile` wants to sit.
      jobLag: this.histogram(
        'job_lag_seconds',
        'Seconds between a job being enqueued and starting',
        ['queue', 'job'],
        [0.1, 0.5, 1, 5, 10, 30, 60, 300, 600],
      ),
    };
  }

  /** False when the package is not installed. */
  get enabled(): boolean {
    return this.registry !== null;
  }

  private counter(
    name: string,
    help: string,
    labelNames: string[] = [],
  ): PromCounter {
    const created = new this.client!.Counter({ name, help, labelNames });

    this.registry!.registerMetric(created);
    this.created.push(created);

    return created;
  }

  private gauge(
    name: string,
    help: string,
    labelNames: string[] = [],
  ): PromGauge {
    const created = new this.client!.Gauge({ name, help, labelNames });

    this.registry!.registerMetric(created);
    this.created.push(created);

    return created;
  }

  private histogram(
    name: string,
    help: string,
    labelNames: string[],
    buckets: number[],
  ): PromHistogram {
    const created = new this.client!.Histogram({
      name,
      help,
      labelNames,
      buckets,
    });

    this.registry!.registerMetric(created);
    this.created.push(created);

    return created;
  }

  // Every method below is a no-op when the package is absent, rather than a guard
  // at each call site. A guard is a line somebody forgets; a no-op is the absence of
  // a line.

  mailSent(template: string, transport: string): void {
    this.counters.mailSent?.inc({ template, transport });
  }

  mailFailed(template: string, transport: string, permanent: boolean): void {
    // `permanent` is a label rather than a second metric because the two are not
    // additive: a 4xx and a timeout are different incidents and an operator
    // asking "are the failures transient" needs them split.
    this.counters.mailFailures?.inc({
      template,
      transport,
      permanent: String(permanent),
    });
  }

  notificationSent(event: string, channel: string, delivered: boolean): void {
    this.counters.notificationSent?.inc({
      event,
      channel,
      delivered: String(delivered),
    });
  }

  /**
   * One sign-in attempt, successful or not.
   *
   * **One counter with an `outcome` label rather than two.** A failure *rate* needs
   * both halves, and two counters mean a dashboard panel that silently shows a
   * count of failures against a different time range than its own denominator.
   *
   * This is the panel behind "is somebody guessing at our passwords", and it is
   * also the only signal that a **brute force is running** — the rate limiter and
   * the lockout both fail open when redis is unreachable, so during a redis outage
   * this counter is the only thing still counting.
   */
  loginAttempt(outcome: 'success' | 'failure'): void {
    this.counters.loginAttempts?.inc({ outcome });
  }

  retentionRowsDeleted(target: string, rows: number): void {
    this.counters.retentionRowsDeleted?.inc({ target }, rows);
  }

  /**
   * Records the queue lag.
   *
   * **`Math.max(0, …)` because a clock that jumps backwards produces a negative
   * observation, and a histogram with a negative bucket silently corrupts every
   * quantile over it.** The clamp is one token and it prevents a metrics pipeline
   * from being wrong for the rest of the process's life.
   */
  jobLag(queue: string, job: string, seconds: number): void {
    this.histograms.jobLag?.observe({ queue, job }, Math.max(0, seconds));
  }

  queueBacklog(queue: string, waiting: number): void {
    this.gauges.queueBacklog?.set({ queue }, waiting);
  }

  deadLettered(total: number): void {
    this.gauges.deadLettered?.set(total);
  }

  maintenanceAgeHours(hours: number): void {
    this.gauges.maintenanceAgeHours?.set(hours);
  }

  /** The exposition format Prometheus scrapes, or null when metrics are disabled. */
  async scrape(): Promise<{ body: string; contentType: string } | null> {
    if (this.registry === null) {
      return null;
    }

    return {
      body: await this.registry.metrics(),
      contentType: this.registry.contentType,
    };
  }

  /** One metric on its own, for the health endpoint's debug output. */
  async single(name: string): Promise<string | null> {
    if (this.registry === null) {
      return null;
    }

    return this.registry.getSingleMetricAsString(name);
  }

  /**
   * Drops every recorded series.
   *
   * Exists for tests, and for one operational reason: after a restart the counters
   * are meaningful but the gauges are not, and a `clear()` lets a maintenance task
   * reset them without bouncing the process.
   *
   * No-op when the package is absent, like everything else here.
   */
  clear(): void {
    for (const metric of this.created) {
      metric.reset();
    }
  }
}
