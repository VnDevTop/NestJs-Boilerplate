import type { LogLevel } from '@nestjs/common';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { runWithRequestId } from '../../common/utils/index.js';
import { AppLogger } from './app.logger.js';

const ALL_LEVELS: LogLevel[] = ['log', 'error', 'warn', 'debug', 'verbose'];

/** Collects what the logger writes, one array entry per line. */
function setup(levels: LogLevel[] = ALL_LEVELS) {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));

      callback();
    },
  });

  return { lines, log: new AppLogger({ levels, stream }) };
}

const parse = (line: string) => JSON.parse(line) as Record<string, unknown>;

/**
 * What the logger is not allowed to do.
 *
 * A logger that can throw breaks the request it was describing. The three ways it
 * could are all real — a cyclic payload, a value whose `toJSON` throws, and a
 * closed stream — and the worst outcome of any of them is an exception escaping a
 * `logger.error` inside a catch block, replacing the original error with an
 * unrelated one. That is the one line written to explain the fault, gone.
 *
 * So these are the tests that matter more than the formatting ones above them.
 */
describe('what the logger never throws', () => {
  it('survives a payload that refers to itself', () => {
    // The case a logger is most likely to meet, because it logs whatever somebody
    // attached to it and a request-scoped object often points back somewhere.
    const { lines, log } = setup();
    const cyclic: Record<string, unknown> = { name: 'req' };

    cyclic['self'] = cyclic;

    expect(() => log.log(cyclic)).not.toThrow();
    expect(lines[0]).toContain('[circular]');
  });

  it('still writes a usable line when the payload is cyclic', () => {
    const { lines, log } = setup();
    const cyclic: Record<string, unknown> = { name: 'req' };

    cyclic['self'] = cyclic;

    log.log(cyclic);

    expect(parse(lines[0] as string)).toMatchObject({ level: 'log' });
  });

  it('survives a value whose toJSON throws', () => {
    // Nasty and real: a library's error object whose `toJSON` serialises a request
    // that no longer exists.
    const { lines, log } = setup();
    const hostile = {
      toJSON() {
        throw new Error('cannot serialise');
      },
    };

    expect(() => log.log(hostile)).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  it('survives a closed stream rather than throwing into the request', () => {
    // A stream closed during shutdown, with a log line still to come.
    const { log } = setup();

    // Simulates the stream being gone: `write` on a destroyed Writable errors.
    (
      log as unknown as { settings: { stream: Writable } }
    ).settings.stream.destroy();

    expect(() => log.error('during shutdown')).not.toThrow();
  });

  it('keeps the timestamp and level when the payload is hostile', () => {
    // The degraded line is worth little on its own, so the fields an operator
    // sorts by have to survive whatever the payload was.
    const { lines, log } = setup();
    const cyclic: Record<string, unknown> = { name: 'req' };

    cyclic['self'] = cyclic;

    log.warn(cyclic);

    expect(parse(lines[0] as string)).toMatchObject({
      level: 'warn',
      timestamp: expect.any(String),
    });
  });
});

describe('redaction on the way in', () => {
  it('removes a password from a structured payload', () => {
    const { lines, log } = setup();

    log.log({ email: 'a@x.com', password: 'hunter2' });

    expect(lines[0]).not.toContain('hunter2');
  });

  it('removes a token from a sentence, which is where most of them are', () => {
    const { lines, log } = setup();

    log.log('reset link sent: ?token=abc123def456&expires=99');

    expect(lines[0]).not.toContain('abc123def456');
  });

  it('removes a bearer token from a message', () => {
    const { lines, log } = setup();

    log.warn('inbound Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload');

    expect(lines[0]).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('redacts inside an Error, whose message is as likely to carry one as any string', () => {
    // Flattened before redaction, because this is the last point where both shapes
    // are still in hand.
    const { lines, log } = setup();

    log.error(new Error('reset failed for ?token=abc123def456'));

    expect(lines[0]).not.toContain('abc123def456');
  });

  it('leaves an ordinary message untouched', () => {
    // A redaction that fires on prose is a redaction nobody reads.
    const { lines, log } = setup();

    log.log('Retention finished in 4s, 42 rows deleted');

    expect(parse(lines[0] as string)).toMatchObject({
      message: 'Retention finished in 4s, 42 rows deleted',
    });
  });
});

describe('AppLogger', () => {
  it('writes one JSON object per line', () => {
    const { lines, log } = setup();

    log.log('started');
    log.warn('careful', 'MyContext');

    expect(lines).toHaveLength(2);
    expect(parse(lines[0])).toMatchObject({ level: 'log', message: 'started' });
    expect(parse(lines[1])).toMatchObject({
      level: 'warn',
      context: 'MyContext',
    });
  });

  it('keeps a multiline message on a single line', () => {
    // A stack trace is the usual source, and a log shipper reads one object per
    // line, so an unescaped newline would split it into broken records.
    const { lines, log } = setup();

    log.error(new Error('boom'));

    expect(lines).toHaveLength(1);
    expect(parse(lines[0]).message).toMatchObject({ name: 'Error' });
  });

  it('serialises an error with its name, message and stack', () => {
    const { lines, log } = setup();

    log.error(new Error('boom'));

    const message = parse(lines[0]).message as Record<string, string>;

    expect(message.name).toBe('Error');
    expect(message.message).toBe('boom');
    expect(message.stack).toContain('Error: boom');
  });

  it('includes the request id while handling a request', () => {
    const { lines, log } = setup();

    runWithRequestId('trace-abc-123456', () => log.log('handling'));

    expect(parse(lines[0]).requestId).toBe('trace-abc-123456');
  });

  it('omits the request id outside a request', () => {
    const { lines, log } = setup();

    log.log('boot');

    expect(parse(lines[0])).not.toHaveProperty('requestId');
  });

  it('does not leak a request id into the next line', () => {
    // The id comes from an async context, so this is the failure mode that would
    // silently mislabel every log line after a request.
    const { lines, log } = setup();

    runWithRequestId('trace-abc-123456', () => log.log('inside'));
    log.log('outside');

    expect(parse(lines[0]).requestId).toBe('trace-abc-123456');
    expect(parse(lines[1])).not.toHaveProperty('requestId');
  });

  it('skips a level it was not given', () => {
    const { lines, log } = setup(['error']);

    log.debug('not wanted');
    log.error('wanted');

    expect(lines).toHaveLength(1);
    expect(parse(lines[0]).message).toBe('wanted');
  });

  it('stamps a timestamp in ISO form', () => {
    const { lines, log } = setup();

    log.log('x');

    expect(parse(lines[0]).timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });
});
