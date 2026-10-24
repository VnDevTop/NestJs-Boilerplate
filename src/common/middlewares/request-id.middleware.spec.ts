import {
  Controller,
  Get,
  type LoggerService,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { REQUEST_ID_HEADER } from '../constants/index.js';
import { catchAllRoute, RequestIdMiddleware } from './index.js';
import { getRequestId } from '../utils/index.js';

/** Filled by the controller, so a test can see what the handler observed. */
const observed: (string | undefined)[] = [];

@Controller()
class ProbeController {
  @Get('items/:id')
  item() {
    observed.push(getRequestId());

    return { id: '1' };
  }

  @Get()
  index() {
    observed.push(getRequestId());

    return { ok: true };
  }
}

/**
 * Mirrors how the application wires the middleware, including the platform
 * dependent pattern, so this exercises the real decision rather than a route list
 * written for the test.
 */
@Module({ controllers: [ProbeController] })
class ProbeModule implements NestModule {
  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestIdMiddleware)
      .forRoutes(catchAllRoute(this.httpAdapterHost.httpAdapter));
  }
}

interface Booted {
  app: { close(): Promise<void> };
  port: number;
}

const started: Booted[] = [];

afterEach(async () => {
  observed.length = 0;

  while (started.length) {
    await started.pop()?.app.close();
  }
});

async function boot(logger: LoggerService | false = false) {
  const app = await NestFactory.create(ProbeModule, new FastifyAdapter());

  app.useLogger(logger);
  await app.listen(0, '127.0.0.1');

  const booted: Booted = {
    app,
    port: (app.getHttpServer().address() as { port: number }).port,
  };

  started.push(booted);

  return booted;
}

const get = (port: number, path: string, requestId?: string) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    headers: requestId === undefined ? {} : { [REQUEST_ID_HEADER]: requestId },
  });

/**
 * Sends a request straight down a socket.
 *
 * `fetch` refuses a header value containing a newline, which is the right
 * behaviour for a client library but also means it cannot express the request
 * this is defending against. Anything able to open a socket can.
 */
function rawGet(port: number, requestId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        [
          'GET / HTTP/1.1',
          'Host: 127.0.0.1',
          `${REQUEST_ID_HEADER}: ${requestId}`,
          'Connection: close',
          '',
          '',
        ].join('\r\n'),
      );
    });

    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (response += chunk));
    socket.on('error', reject);
    socket.on('end', () => resolve(response));
  });
}

const statusOf = (raw: string) => raw.split('\r\n')[0] ?? '';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('request id middleware on fastify', () => {
  it('sets a generated id on a nested route and inside the handler', async () => {
    const { port } = await boot();
    const response = await get(port, '/items/7');
    const sent = response.headers.get(REQUEST_ID_HEADER);

    expect(sent).toMatch(UUID);
    // The point of the async context: the handler read the same id without ever
    // being handed the request.
    expect(observed).toEqual([sent]);
  });

  it('covers the root route, not only the nested one', async () => {
    const { port } = await boot();

    expect((await get(port, '/')).headers.get(REQUEST_ID_HEADER)).toMatch(UUID);
    expect(observed).toHaveLength(1);
  });

  it('reuses a caller supplied id', async () => {
    const { port } = await boot();
    const response = await get(port, '/', `fastify-trace-1234`);

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(`fastify-trace-1234`);
    expect(observed).toEqual([`fastify-trace-1234`]);
  });

  it('replaces a caller id outside the safe charset', async () => {
    // The server accepts these, so they reach the middleware, and the middleware
    // is what has to keep them out of every log line.
    const { port } = await boot();
    const sent = (await get(port, '/', 'trace abc 1234567890')).headers.get(
      REQUEST_ID_HEADER,
    );

    expect(sent).toMatch(UUID);
    expect(observed).toEqual([sent]);
  });

  it('cannot be tricked into echoing a forged log line', async () => {
    // A newline in a header is rejected by the HTTP parser before any handler
    // runs, so the response never carries the attacker's text back.
    const { port } = await boot();
    const raw = await rawGet(port, 'forged\nINFO admin logged in');

    expect(statusOf(raw)).toContain('400');
    expect(raw).not.toContain('INFO admin logged in');
  });

  it('leaves no request id behind for the next request', async () => {
    const { port } = await boot();

    await get(port, '/', 'first-trace-1');
    await get(port, '/');

    expect(observed[0]).toBe('first-trace-1');
    expect(observed[1]).not.toBe('first-trace-1');
    expect(observed[1]).toMatch(UUID);
  });
});

describe('route pattern', () => {
  it('boots on fastify', async () => {
    await boot();
    await get(started[0].port, '/');

    expect(started[0].port).toBeGreaterThan(0);
  });
});
