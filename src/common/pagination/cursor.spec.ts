import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor } from './cursor.js';

describe('cursor', () => {
  it('round-trips a boundary', () => {
    const decoded = decodeCursor(
      encodeCursor({ value: '2026-10-03T03:17:01.234Z', id: 'row-1' }),
    );

    expect(decoded).toEqual({ value: '2026-10-03T03:17:01.234Z', id: 'row-1' });
  });

  it('survives a query string without escaping', () => {
    const cursor = encodeCursor({ value: 'a+b/c=', id: 'id?' });

    // base64url, not base64: a `+` or `/` in the payload would be re-encoded or
    // dropped by whatever carries the query string, and the client would come back
    // with a cursor this decoder refuses — a failure that looks like the server
    // losing state rather than a URL-encoding accident.
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual({ value: 'a+b/c=', id: 'id?' });
  });

  it('treats an absent or empty cursor as no cursor', () => {
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(decodeCursor(null)).toBeUndefined();
    expect(decodeCursor('')).toBeUndefined();
    expect(decodeCursor('   ')).toBeUndefined();
  });

  it('tolerates the trailing whitespace a copy-paste leaves behind', () => {
    const cursor = encodeCursor({ value: 'v', id: 'i' });

    expect(decodeCursor(` ${cursor} `)).toEqual({ value: 'v', id: 'i' });
  });

  it('refuses a cursor that is not base64 JSON', () => {
    // The alternative — ignoring it — hands back page one for a request for page
    // four, which is a correct-looking response to the wrong question.
    expect(() => decodeCursor('not-a-cursor')).toThrow(BadRequestException);
    expect(() => decodeCursor('not-a-cursor')).toThrow(/opaque/i);
  });

  it('refuses a payload that parses but is not a cursor', () => {
    const notACursor = Buffer.from(JSON.stringify({ v: 1 }), 'utf8').toString(
      'base64url',
    );

    // A hand-built or corrupted payload must not produce `{ value: undefined }`,
    // because that value ends up in a SQL comparison where it becomes NULL and
    // silently matches nothing — a 200 carrying an empty list.
    expect(() => decodeCursor(notACursor)).toThrow(BadRequestException);
  });

  it('refuses a cursor from a different cursor format version', () => {
    const future = Buffer.from(
      JSON.stringify({ v: 99, s: 'v', i: 'i' }),
      'utf8',
    ).toString('base64url');

    expect(() => decodeCursor(future)).toThrow(/Unsupported cursor/);
  });

  it('refuses a cursor with no id', () => {
    const emptyId = Buffer.from(
      JSON.stringify({ v: 1, s: 'v', i: '' }),
      'utf8',
    ).toString('base64url');

    expect(() => decodeCursor(emptyId)).toThrow(BadRequestException);
  });

  it('is opaque: the boundary is not readable as plain text', () => {
    const cursor = encodeCursor({ value: '2026-10-03', id: 'visible-id' });

    expect(cursor).not.toContain('visible-id');
    expect(cursor).not.toContain('2026-10-03');
  });
});
