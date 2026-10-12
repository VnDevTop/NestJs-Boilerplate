import { describe, expect, it, vi } from 'vitest';

import { TypeOrmTracingLogger } from './typeorm-tracing.logger.js';
import type { TracingService } from './tracing.service.js';

/**
 * Two properties, both of which are about not making things worse.
 *
 * **The parameters never go in.** TypeORM hands this logger the query *and* the
 * parameters, and the parameters are where a password hash, an address and a reset
 * token all live. A span carrying them is a span in a tracing backend — a
 * different store, with a different retention policy to the database and usually a
 * much longer one.
 *
 * **Nothing here throws.** This runs inside the database path, so a failure would
 * look like a database failure, and a logger that logs on every query would be the
 * outage this module exists to help diagnose.
 */

function tracingThatRecords() {
  const spans: { name: string; attributes: Record<string, unknown> }[] = [];
  const exceptions: unknown[] = [];

  const span = {
    attributes: {} as Record<string, unknown>,
    isRecording: () => true,
    setAttribute(key: string, value: unknown) {
      span.attributes[key] = value;

      return span;
    },
    setAttributes(attributes: Record<string, unknown>) {
      Object.assign(span.attributes, attributes);

      return span;
    },
    recordException(error: unknown) {
      exceptions.push(error);

      return span;
    },
    setStatus(status: { code: number }) {
      span.attributes['status'] = status.code;

      return span;
    },
    end() {
      spans.push({ name: current, attributes: span.attributes });
    },
    spanContext: () => ({ traceId: '', spanId: '', traceFlags: 0 }),
  };

  let current = '';

  const tracing = {
    errorCode: () => 2,
    startSpan(name: string, attributes: Record<string, unknown> = {}) {
      current = name;
      span.attributes = { ...attributes };

      return span;
    },
  } as unknown as TracingService;

  return { tracing, spans, exceptions, span };
}

describe('a slow query', () => {
  it('becomes a span carrying the statement', () => {
    const h = tracingThatRecords();
    const logger = new TypeOrmTracingLogger(h.tracing);

    logger.logQuerySlow(450, 'SELECT * FROM "users" WHERE "id" = $1');

    expect(h.spans[0]).toMatchObject({
      name: 'db.query',
      attributes: { 'db.statement': 'SELECT * FROM "users" WHERE "id" = $1' },
    });
  });

  it('never receives the parameters, because that is where a secret is', () => {
    const h = tracingThatRecords();
    const logger = new TypeOrmTracingLogger(h.tracing);

    // TypeORM's signature passes them as a third argument. They are accepted and
    // ignored — accepting them is what keeps the method matching the interface,
    // and ignoring them is what keeps a secret out of a span.
    logger.logQuerySlow(450, 'SELECT * FROM "users" WHERE "email" = $1', [
      'scrypt$salt$key',
    ]);

    expect(JSON.stringify(h.spans)).not.toContain('scrypt');
  });
});

describe('a failed query', () => {
  it('records the exception and marks the span failed', () => {
    const h = tracingThatRecords();
    const logger = new TypeOrmTracingLogger(h.tracing);
    const error = new Error('deadlock detected');

    logger.logQueryError(error, 'SELECT 1');

    expect(h.exceptions).toEqual([error]);
    expect(h.spans[0]?.name).toBe('db.query.failed');
  });
});

describe('every ordinary query', () => {
  it('produces no span at all', () => {
    // A span per statement turns a burst of traffic into a burst of tracing
    // traffic; the sampler then drops almost everything, including the slow query
    // somebody was looking for. TypeORM's `logQuerySlow` is the hook that already
    // knows the duration, so nothing is timed twice.
    const h = tracingThatRecords();
    const logger = new TypeOrmTracingLogger(h.tracing);

    logger.logQuery('SELECT 1', []);

    expect(h.spans).toEqual([]);
  });
});

describe('when tracing throws', () => {
  it('does not take the query down with it', () => {
    const tracing = {
      errorCode: () => 2,
      startSpan() {
        throw new Error('the sampler exploded');
      },
    } as unknown as TracingService;

    const logger = new TypeOrmTracingLogger(tracing);

    expect(() => logger.logQuerySlow(450, 'SELECT 1')).not.toThrow();
    expect(() =>
      logger.logQueryError(new Error('x'), 'SELECT 1'),
    ).not.toThrow();
  });

  it('swallows a logging failure too, since it sits in the database path', () => {
    const h = tracingThatRecords();
    const logger = new TypeOrmTracingLogger(h.tracing);
    vi.spyOn(
      logger as unknown as { logger: Record<string, () => unknown> },
      'logger',
      'get',
    ).mockReturnValue({
      log: () => {
        throw new Error('stream closed');
      },
      error: () => {
        throw new Error('stream closed');
      },
      warn: () => undefined,
    });

    expect(() =>
      logger.log('info', 'Executing (default): SELECT 1'),
    ).not.toThrow();
  });
});
