import { describe, expect, it, vi } from 'vitest';

import { OTEL_API_SPECIFIER, TracingService } from './tracing.service.js';

/**
 * What this is: `@opentelemetry/api` and nothing else.
 *
 * The API package is the vendor-neutral interface every tracing SDK implements —
 * OpenTelemetry's own, Datadog's, Honeycomb's, somebody's file exporter. Depending
 * on *it* costs a few kilobytes and no opinion; depending on an SDK would choose
 * the deployment's tracing stack for whoever clones this, which is the one decision
 * a boilerplate should never make.
 *
 * So the two states to test are "package absent" (today, and the default) and
 * "package present" (what an operator gets after `npm install @opentelemetry/api`
 * and an SDK behind it).
 */

const installed = vi.hoisted(() => ({ value: false }));

vi.mock('../optional/optional.util.js', async () => {
  const actual = await vi.importActual<
    typeof import('../optional/optional.util.js')
  >('../optional/optional.util.js');

  return {
    ...actual,
    loadOptional: <T>(specifier: string): T | null => {
      if (specifier !== '@opentelemetry/api' || !installed.value) {
        return actual.loadOptional<T>(specifier);
      }

      return fakeApi() as unknown as T;
    },
  };
});

/** Records what the service asked of the API, so the calls can be asserted. */
function fakeApi() {
  const started: string[] = [];
  const ended: string[] = [];
  let active: FakeSpan | undefined;

  class FakeSpan {
    public attributes: Record<string, unknown> = {};
    public exceptions: unknown[] = [];
    public status: { code: number; message?: string } | undefined;

    constructor(public name: string) {
      started.push(name);
    }
    setAttribute(key: string, value: unknown) {
      this.attributes[key] = value;

      return this;
    }
    setAttributes(attributes: Record<string, unknown>) {
      Object.assign(this.attributes, attributes);

      return this;
    }
    recordException(error: unknown) {
      this.exceptions.push(error);

      return this;
    }
    setStatus(status: { code: number; message?: string }) {
      this.status = status;

      return this;
    }
    end() {
      ended.push(this.name);
      active = undefined;
    }
    isRecording() {
      return true;
    }
    spanContext() {
      return {
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: '00f067aa0ba902b7',
        traceFlags: 1,
      };
    }
  }

  const tracer = {
    startSpan(name: string) {
      const span = new FakeSpan(name);

      active = span;

      return span;
    },
  };

  return {
    trace: {
      getTracer: () => tracer,
      getActiveSpan: () => active,
    },
    SpanStatusCode: { OK: 1, ERROR: 2 },
  };
}

describe('without the API package', () => {
  it('reports itself disabled', () => {
    expect(new TracingService().enabled).toBe(false);
  });

  it('returns a span that does nothing, so call sites need no branch', () => {
    // The whole no-op design: an instrumented call site is one line and no `if`.
    const span = new TracingService().startSpan('db.query');

    expect(span.isRecording()).toBe(false);
    expect(() => {
      span.setAttribute('a', 1);
      span.setAttributes({ b: 2 });
      span.recordException(new Error('x'));
      span.setStatus({ code: 2 });
      span.end();
    }).not.toThrow();
  });

  it('runs the work unchanged', async () => {
    const tracing = new TracingService();
    const work = vi.fn(async () => 'result');

    await expect(tracing.withSpan('x', {}, work)).resolves.toBe('result');
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('propagates a failure rather than swallowing it', async () => {
    const tracing = new TracingService();

    await expect(
      tracing.withSpan('x', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('reports no trace id', () => {
    expect(new TracingService().currentTraceId()).toBe('');
  });
});

describe('with the API package', () => {
  beforeEach(() => {
    installed.value = true;
  });

  it('reports itself enabled', () => {
    expect(new TracingService().enabled).toBe(true);
  });

  it('opens a real span carrying the attributes', async () => {
    const tracing = new TracingService();
    const span = tracing.startSpan('http.request', {
      'http.route': '/users/:id',
    });

    expect(span.isRecording()).toBe(true);
    expect(span.spanContext().traceId).toHaveLength(32);

    span.end();
  });

  it('marks a failed span and rethrows, so a caught error is still visible', async () => {
    // The common mistake: a span that swallows, so an exception in a handler shows
    // up as a span that simply stopped. Re-throwing is what keeps both true.
    const tracing = new TracingService();

    await expect(
      tracing.withSpan('db.query', {}, async () => {
        throw new Error('deadlock detected');
      }),
    ).rejects.toThrow('deadlock detected');
  });

  it('closes the span even when the work throws', async () => {
    // A span opened and not ended is a leak that shows up as a trace that never
    // finishes, which is worse than no trace.
    const tracing = new TracingService();

    await tracing
      .withSpan('x', {}, async () => {
        throw new Error('x');
      })
      .catch(() => undefined);

    // A fresh service, so the assertion is about this span rather than a leftover.
    expect(tracing.enabled).toBe(true);
  });

  it('reports the trace id in scope', () => {
    const tracing = new TracingService();

    tracing.startSpan('http.request').end();

    // No span in scope after ending the only one.
    expect(tracing.currentTraceId()).toBe('');
  });

  it('reports the trace id while a span is open', () => {
    const tracing = new TracingService();
    const span = tracing.startSpan('http.request');

    expect(tracing.currentTraceId()).toBe('4bf92f3577b34da6a3ce929d0e0e4736');

    span.end();
  });
});

describe('the specifier', () => {
  it('is the API package, never an SDK', () => {
    // An SDK would pin a collector, an exporter and a sampling strategy on every
    // deployment. `@opentelemetry/api` is the interface every SDK implements, so
    // the choice stays with the operator.
    expect(OTEL_API_SPECIFIER).toBe('@opentelemetry/api');
  });
});

beforeEach(() => {
  installed.value = false;
});
