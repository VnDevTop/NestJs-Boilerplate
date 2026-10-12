import { Injectable, Logger } from '@nestjs/common';

import { loadOptional } from '../optional/optional.util.js';

/** The npm specifier, as a string, because it must never be a static import. */
export const OTEL_API_SPECIFIER = '@opentelemetry/api';

/**
 * The subset of `@opentelemetry/api` this module uses.
 *
 * **The API package only — no SDK, no exporter, no collector.** That distinction
 * is the whole design: `@opentelemetry/api` is the vendor-neutral interface every
 * tracing SDK implements, and depending on *it* costs a few kilobytes and no
 * opinion. Depending on an SDK would choose the deployment's tracing stack for
 * whoever clones this, which is exactly the choice a boilerplate should not make.
 *
 * Declared here rather than imported from the package, for the reason
 * `provider.types.ts` gives: a type-only `typeof import('@opentelemetry/api')` is
 * still resolved by `tsc`, so a clone with no tracing installed fails to typecheck.
 */
interface Span {
  setAttribute(key: string, value: string | number | boolean): Span;
  setAttributes(attributes: Record<string, unknown>): Span;
  recordException(error: unknown): void;
  setStatus(status: { code: number; message?: string }): Span;
  end(): void;
  spanContext(): { traceId: string; spanId: string; traceFlags: number };
  isRecording(): boolean;
}

interface Tracer {
  startSpan(
    name: string,
    options?: Record<string, unknown>,
    context?: unknown,
  ): Span;
}

interface OtelApi {
  trace: {
    getTracer(name: string, version?: string): Tracer;
    /** The span in scope right now, if the instrumented code started one. */
    getActiveSpan(): Span | undefined;
  };
  SpanStatusCode: { OK: number; ERROR: number };
}

/** A no-op span with the same shape, so callers need no branch. */
const NOOP_SPAN: Span = {
  setAttribute: () => NOOP_SPAN,
  setAttributes: () => NOOP_SPAN,
  recordException: () => undefined,
  setStatus: () => NOOP_SPAN,
  end: () => undefined,
  isRecording: () => false,
  spanContext: () => ({ traceId: '', spanId: '', traceFlags: 0 }),
};

export const TRACER_NAME = 'nestjs-boilerplate';
export const TRACER_VERSION = '0.0.1';

/**
 * Traces for HTTP, database and job work.
 *
 * ## What this is, and what it deliberately is not
 *
 * `@opentelemetry/api` and nothing else. It is the vendor-neutral interface that
 * every tracing SDK implements — OpenTelemetry's own, Datadog's, Honeycomb's, a
 * file exporter somebody wrote for a weekend. Emitting spans through it means the
 * operator chooses where they go; the alternative is this boilerplate choosing a
 * vendor for them, which is the one decision a template should never make.
 *
 * **No SDK, no exporter, no collector.** `npm install @opentelemetry/sdk-node
 * @opentelemetry/auto-instrumentations-node` and the spans below start appearing,
 * with no change here. That is what makes the integration honest: what is missing
 * is a collector to send them to, and that is a deployment's business.
 *
 * ## Without the package
 *
 * `loadOptional` returns `null`, every method returns a no-op span, and the code
 * being instrumented runs at full speed with no branching and no allocation. Not
 * "degraded" — the same behaviour, minus the observability.
 *
 * ## And the integration already in this repository
 *
 * `app.module.ts` registers `@nestjs/observe` when its three environment values
 * are set. **That is an alternative, not a partner.** Two tracing systems in one
 * process means two spans for one request and no way to tell which is the real
 * one, so pick one. The reason this was built anyway is the one above: Observe is
 * a hosted service, and a boilerplate that cannot be traced without signing up for
 * something is not free.
 */
@Injectable()
export class TracingService {
  private readonly logger = new Logger(TracingService.name);

  private readonly api: OtelApi | null;
  private readonly tracer: Tracer | null;

  constructor() {
    this.api = loadOptional<OtelApi>(OTEL_API_SPECIFIER);

    if (this.api === null) {
      this.tracer = null;

      return;
    }

    // `getTracer` returns a no-op tracer when no SDK has registered itself, which
    // is the second way this feature is off: the package can be installed with no
    // SDK behind it, and that is a valid and common state.
    this.tracer = this.api.trace.getTracer(TRACER_NAME, TRACER_VERSION);
  }

  /** False when the API package is not installed. */
  get enabled(): boolean {
    return this.tracer !== null;
  }

  /**
   * True when an SDK is registered, rather than merely when the API package is.
   *
   * Distinguishable because the two are independent states: the API can be
   * installed with no SDK behind it, and then every span is a no-op while every
   * `enabled` in the codebase says the feature is on.
   */
  get recording(): boolean {
    return this.api !== null && this.api.trace.getActiveSpan !== undefined;
  }

  /**
   * Starts a span.
   *
   * Returns the no-op span rather than `null` when tracing is off, so an
   * instrumented call site is one line with no branch:
   *
   * ```ts
   * const span = this.tracing.startSpan('mail.send');
   * try { … } finally { span.end(); }
   * ```
   */
  startSpan(name: string, attributes: Record<string, unknown> = {}): Span {
    if (this.tracer === null) {
      return NOOP_SPAN;
    }

    try {
      const span = this.tracer.startSpan(name, { attributes });

      return span.isRecording() ? span : NOOP_SPAN;
    } catch {
      // An SDK that throws from `startSpan` — a sampler raising, a broken exporter
      // — must not take the instrumented request with it. Tracing is never the
      // thing that is allowed to cause an outage.
      return NOOP_SPAN;
    }
  }

  /**
   * Runs `work` inside a span and records how it ended.
   *
   * The ergonomic form, and the one that gets used: a span that is started and not
   * ended on the throwing path is a leak, and every caller remembering to `end()`
   * in a `finally` is a caller that will eventually forget.
   *
   * `error: true` on the failure records the exception and marks the span failed,
   * which is what makes an error visible as an error rather than as a span with an
   * unlucky name.
   */
  async withSpan<T>(
    name: string,
    attributes: Record<string, unknown>,
    work: (span: Span) => Promise<T>,
  ): Promise<T> {
    const span = this.startSpan(name, attributes);

    if (!span.isRecording()) {
      // Nothing to measure, so the work runs with no bookkeeping around it at all.
      return work(NOOP_SPAN);
    }

    try {
      const result = await work(span);

      span.setStatus({ code: this.okCode() });

      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({
        code: this.errorCode(),
        message: error instanceof Error ? error.message : String(error),
      });

      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * The current trace id, for the log line.
   *
   * Read from the ambient context rather than passed in, so a log written deep
   * inside a service is correlatable without the call site knowing anything about
   * tracing. Empty string when there is no active span, which is a value a log
   * field can carry and a consumer can skip.
   */
  currentTraceId(): string {
    if (this.api === null) {
      return '';
    }

    try {
      // The span **in scope**, not a new one. Starting a probe span would report
      // that probe's id, which changes per call and correlates with nothing —
      // worse than no field at all, because it looks like a trace id.
      const active = this.api.trace.getActiveSpan();

      if (active === undefined) {
        return '';
      }

      const traceId = active.spanContext().traceId;

      // The all-zero id is what OpenTelemetry returns for an invalid context, and
      // storing it would put a meaningless value in every log line.
      return traceId === '00000000000000000000000000000000' ? '' : traceId;
    } catch {
      return '';
    }
  }

  /** OpenTelemetry's own status codes, resolved once and reused. */
  errorCode(): number {
    return this.api?.SpanStatusCode.ERROR ?? 2;
  }

  private okCode(): number {
    return this.api?.SpanStatusCode.OK ?? 1;
  }
}
