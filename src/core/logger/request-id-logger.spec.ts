import { Injectable, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';

import { REQUEST_ID_HEADER } from '../../common/constants/index.js';
import { RequestIdMiddleware } from '../../common/middlewares/index.js';
import { AppLogger } from './app.logger.js';

@Injectable()
class ServiceWithLogger {
  private readonly logger = new Logger('SomeService');

  work(): void {
    this.logger.error(new Error('boom'));
  }
}

/** Captures what the logger writes, one array entry per line. */
function server() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));

      callback();
    },
  });

  return { lines, log: new AppLogger({ levels: ['log', 'error'], stream }) };
}

/** Runs `work` inside a real request, and returns the id that was sent back. */
function inRequest(
  id: string | undefined,
  work: () => void,
): string | undefined {
  const middleware = new RequestIdMiddleware();
  const headers: Record<string, string> = {};

  middleware.use(
    {
      headers: id === undefined ? {} : { [REQUEST_ID_HEADER]: id },
    } as unknown as FastifyRequest,
    {
      setHeader: (name: string, value: string) => (headers[name] = value),
    } as unknown as FastifyReply,
    (() => work()) as () => void,
  );

  return headers[REQUEST_ID_HEADER];
}

/**
 * Guards the chain the request id depends on: the middleware establishes the id,
 * a service logging while the request runs can read it, and a log written after
 * the request is finished is not labelled with it.
 */
describe('request id reaches the logger', () => {
  let lines: string[];
  let service: ServiceWithLogger;

  beforeEach(() => {
    const captured = server();

    lines = captured.lines;
    service = new ServiceWithLogger();
    Logger.overrideLogger(captured.log);
  });

  const firstEntry = () => JSON.parse(lines[0]) as Record<string, string>;

  it('labels a log line written during the request', () => {
    const sent = inRequest('trace-abc-123456', () => service.work());

    expect(sent).toBe('trace-abc-123456');
    expect(firstEntry()).toMatchObject({
      context: 'SomeService',
      requestId: 'trace-abc-123456',
    });
  });

  it('generates an id when the caller sends none', () => {
    inRequest(undefined, () => service.work());

    expect(firstEntry().requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('reuses a caller supplied id', () => {
    // One identifier has to survive across services, a proxy and the logs.
    expect(inRequest('upstream-abc-123456', () => service.work())).toBe(
      'upstream-abc-123456',
    );
    expect(firstEntry().requestId).toBe('upstream-abc-123456');
  });

  it('replaces a caller id that could forge a log line', () => {
    const sent = inRequest('forged\nINFO admin logged in', () =>
      service.work(),
    );

    expect(sent).not.toContain('\n');
    expect(firstEntry().requestId).not.toContain('\n');
  });

  it('does not label a log line written after the request', () => {
    // The id lives in an async context, so leaking it would mislabel everything
    // that happens between two requests.
    inRequest('trace-abc-123456', () => undefined);
    service.work();

    expect(firstEntry()).not.toHaveProperty('requestId');
  });
});
