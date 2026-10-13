import { Injectable, Logger } from '@nestjs/common';

import { loadOptional } from '../optional/optional.util.js';
import { appVersion } from './sentry-release.js';

/** The npm specifier, as a string, because it must never be a static import. */
export const SENTRY_SPECIFIER = '@sentry/node';

export interface SentryLike {
  captureException(
    error: unknown,
    hint?: { extra?: Record<string, unknown>; tags?: Record<string, string> },
  ): string;
  captureMessage(
    message: string,
    hint?: {
      level?: string;
      tags?: Record<string, string>;
      extra?: Record<string, unknown>;
    },
  ): string;
  addBreadcrumb(breadcrumb: {
    category?: string;
    message?: string;
    level?: string;
    data?: Record<string, unknown>;
  }): void;
  flush(timeout?: number): Promise<boolean>;
}

/**
 * Reports unhandled errors to Sentry, or nowhere.
 *
 * ## One event per *incident*, not per request
 *
 * The error filter calls this once per unhandled exception, and the rate limiter
 * is not involved. What stops a bug from producing ten thousand events is
 * Sentry's own `sampleRate` and its own grouping — not a limit invented here,
 * which would drop the events nobody wanted to see as reliably as the ones
 * somebody did.
 *
 * ## `beforeSend` is configured for this application, not left default
 *
 * **Request bodies and headers are stripped.** The default Sentry integration
 * attaches them, and they are where a password, a reset token and a two-factor
 * code arrive. An error reporting service holding a sign-up body is a
 * credential store with a very different blast radius than the database.
 *
 * The breadcrumb trail is kept, because it is what makes an error
 * explainable — "this failed after the notification to Slack" is the difference
 * between a bug report and a puzzle.
 *
 * ## The release tag
 *
 * Read from `SENTRY_RELEASE`, falling back to the package version. Without a
 * release, Sentry cannot tell a regression from the deploy that introduced it,
 * and its issue list is a wall of "new since Tuesday" with nothing separating
 * them. Set it in CI from the git SHA and the feature starts earning its keep.
 *
 * ## When it is not installed
 *
 * Every method returns without doing anything. No DSN means no events, and the
 * error filter still logs locally, so nothing about the application's behaviour
 * changes — the exception still reaches the log, still reaches the client, still
 * reaches the operator through whatever reads it.
 */
@Injectable()
export class SentryService {
  private readonly logger = new Logger(SentryService.name);

  private readonly sentry: SentryLike | null;

  constructor(dsn: string | undefined = process.env['SENTRY_DSN']) {
    // Present in the graph but not installed: `enabled` is false and everything
    // below is a no-op. Separated from "not configured" below because the two
    // mean different things to whoever is looking.
    const sdk = loadOptional<SentryLike>(SENTRY_SPECIFIER);

    if (sdk === null) {
      if (dsn) {
        this.logger.warn(
          `SENTRY_DSN is set but ${SENTRY_SPECIFIER} is not installed, so no ` +
            'errors will be reported. Install it: npm install @sentry/node',
        );
      }

      this.sentry = null;

      return;
    }

    if (!dsn) {
      this.sentry = null;

      return;
    }

    // Loaded lazily and by string name because the SDK's `init` is the only API
    // that takes configuration, and the options here — `beforeSend`, `tracesSampleRate`
    // — are the whole point of having this at all.
    const init = (
      sdk as unknown as {
        init?: (options: Record<string, unknown>) => void;
      }
    ).init;

    init?.({
      dsn,
      release: process.env['SENTRY_RELEASE'] ?? appVersion(),
      environment: process.env['NODE_ENV'] ?? 'development',
      // No performance tracing: the spans in `core/tracing` go to OpenTelemetry,
      // and running the same request through two tracing systems doubles the cost
      // and splits the trace.
      tracesSampleRate: 0,
      beforeSend: (event: Record<string, unknown>) => this.scrub(event),
    });

    this.sentry = sdk;
  }

  /** True only when an SDK is installed *and* a DSN is configured. */
  get enabled(): boolean {
    return this.sentry !== null;
  }

  /**
   * Reports an error, with the request context that makes it explainable.
   *
   * Never throws. This is called from an exception filter, which is the last
   * place a process is still running; an error reporter that throws turns a
   * handled 500 into a dead process.
   */
  captureException(
    error: unknown,
    context: {
      requestId?: string | undefined;
      traceId?: string | undefined;
      route?: string | undefined;
      method?: string | undefined;
      userId?: string | undefined;
    } = {},
  ): void {
    if (this.sentry === null) {
      return;
    }

    try {
      this.sentry.captureException(error, {
        tags: {
          requestId: context.requestId ?? '',
          traceId: context.traceId ?? '',
        },
        extra: {
          // The route pattern and the method, never the url: a reset link in the
          // query string is a bearer credential and this is a third-party store.
          route: context.route ?? '',
          method: context.method ?? '',
          userId: context.userId ?? '',
        },
      });
    } catch (reportingFailure) {
      this.logger.warn(
        `Could not report an error to Sentry: ${String(reportingFailure)}`,
      );
    }
  }

  captureMessage(message: string, tags: Record<string, string> = {}): void {
    if (this.sentry === null) {
      return;
    }

    try {
      this.sentry.captureMessage(message, { tags });
    } catch (error) {
      this.logger.warn(
        `Could not report a message to Sentry: ${String(error)}`,
      );
    }
  }

  /**
   * Adds a breadcrumb.
   *
   * Optional and off by default in the options above. A breadcrumb is a small
   * amount of context sent on every event, which is useful and is also a place
   * a request body could end up — so the caller passes what it means to pass.
   */
  addBreadcrumb(message: string, data: Record<string, unknown> = {}): void {
    if (this.sentry === null) {
      return;
    }

    try {
      this.sentry.addBreadcrumb({
        category: 'app',
        message,
        data,
      });
    } catch {
      // Nothing here is worth a log line of its own.
    }
  }

  /**
   * Flushes buffered events.
   *
   * Called from `onApplicationShutdown` and not from anywhere else: Sentry's
   * transport batches, and a process that exits without flushing loses the last
   * few events — which are the ones around the reason it exited.
   */
  async flush(timeoutMs = 2_000): Promise<void> {
    if (this.sentry === null) {
      return;
    }

    try {
      await this.sentry.flush(timeoutMs);
    } catch (error) {
      this.logger.warn(`Could not flush Sentry: ${String(error)}`);
    }
  }

  /**
   * Strips what must never leave the process.
   *
   * Called before anything is sent, so it applies to events Sentry's own
   * integrations attach as well as the ones this module creates. The request
   * headers and cookies are removed outright rather than filtered key by key:
   * an allowlist is a list somebody extends, and the extension is what leaks.
   */
  private scrub(event: Record<string, unknown>): Record<string, unknown> {
    const request = event['request'] as Record<string, unknown> | undefined;

    if (request !== undefined) {
      delete request['headers'];
      delete request['cookies'];
      delete request['data'];
      delete request['body_string'];
      // The url keeps its path and drops its query. A reset, verification or
      // unlock link is entirely in the query string and works exactly once for
      // whoever holds it, which is nobody who should be reading an error report.
      const url = request['url'];

      if (typeof url === 'string') {
        request['url'] = url.split('?')[0] ?? url;
      }
    }

    const extra = event['extra'] as Record<string, unknown> | undefined;

    if (extra !== undefined) {
      delete extra['body'];
      delete extra['password'];
      delete extra['token'];
    }

    return event;
  }
}
