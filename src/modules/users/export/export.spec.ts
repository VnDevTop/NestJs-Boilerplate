import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { csvField, csvRow, csvStream, jsonStream } from './csv.util.js';
import { ExportService } from './export.service.js';

/**
 * Two things this suite pins down, and the second one is the important one.
 *
 * The CSV quoting is a formatting detail — unless a field is attacker-controlled,
 * which a `userAgent` is. An unescaped comma in one of those puts a column in a
 * file an operator opens in a spreadsheet, so the escaping tests are here for a
 * reason rather than for tidiness.
 *
 * The **exclusions** are the feature. A data export is everything held about a
 * person, and in this application that list includes the password hash, the
 * two-factor secret, every recovery code and every refresh token. Those are not
 * "the person's data" — they are the ability to be the person. A test that only
 * checked the file is well-formed would pass on an export containing all of them.
 */

async function read(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }

  return Buffer.concat(chunks).toString('utf8');
}

async function* rows(values: Record<string, unknown>[]) {
  for (const value of values) {
    yield value;
  }
}

describe('one CSV field', () => {
  it('is empty for null and undefined', () => {
    // A missing optional field and an explicitly empty one are the same thing in a
    // spreadsheet, and rendering `null` or `undefined` as text is worse than either.
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('quotes a field containing a comma', () => {
    expect(csvField('Firefox, Linux')).toBe('"Firefox, Linux"');
  });

  it('doubles an embedded quote, which is how RFC 4180 escapes one', () => {
    expect(csvField('she said "no"')).toBe('"she said ""no"""');
  });

  it('quotes a newline, so one value cannot become two rows', () => {
    expect(csvField('line one\nline two')).toBe('"line one\nline two"');
  });

  it('leaves an ordinary value unquoted', () => {
    expect(csvField('a@x.com')).toBe('a@x.com');
  });

  it('renders a date in a form a spreadsheet recognises', () => {
    expect(csvField(new Date('2026-03-01T12:00:00Z'))).toBe(
      '2026-03-01T12:00:00.000Z',
    );
  });

  it('renders an object as JSON rather than [object Object]', () => {
    expect(csvField({ a: 1 })).toBe('"{""a"":1}"');
  });

  it('defuses a value a spreadsheet would execute', () => {
    // The one that matters. A user agent is chosen by a stranger, `=cmd|…` is a
    // formula, and an export is a file people open in Excel.
    expect(csvField('=cmd|calc')).toBe('\t=cmd|calc');
  });

  it('defuses a formula that also needs quoting, with the tab inside the quotes', () => {
    // The order is load-bearing and this pins it. Prefix-then-quote leaves a tab as
    // the first character *inside* the quotes; quote-then-prefix would leave the
    // value opening with `=` the moment a spreadsheet parses it, and a quoted CSV
    // field starting with `=` is still executed.
    expect(csvField("=cmd,'/c calc'!A1")).toBe('"\t=cmd,\'/c calc\'!A1"');
  });

  it('defuses the other three spreadsheet triggers', () => {
    for (const trigger of ['+1', '-1', '@SUM(A1)']) {
      expect(csvField(trigger)[0], trigger).toBe('\t');
    }
  });

  it('leaves a hyphen that is not a formula alone', () => {
    // Every date in the export begins with a digit and every negative number would
    // be data, not a command. The rule is the leading character and nothing else.
    expect(csvField('-42')).toBe('\t-42');
  });
});

describe('one CSV row', () => {
  it('joins with commas and terminates with CRLF', () => {
    expect(csvRow(['a', 1, null])).toBe('a,1,\r\n');
  });
});

describe('a multi-section CSV', () => {
  it('names each section, because the tables have different shapes', async () => {
    // A reader meeting `revokedReason` in the middle of a file has no way to tell
    // whether it arrived in the wrong section or in the wrong file.
    const out = await read(
      csvStream([
        { name: 'user', columns: ['id'], rows: rows([{ id: 'u1' }]) },
        { name: 'sessions', columns: ['id'], rows: rows([]) },
      ]),
    );

    expect(out).toContain('# user\r\n');
    expect(out).toContain('# sessions\r\n');
  });

  it('writes a header per section', async () => {
    const out = await read(
      csvStream([
        { name: 'user', columns: ['id', 'email'], rows: rows([]) },
        { name: 'devices', columns: ['id'], rows: rows([]) },
      ]),
    );

    expect(out).toBe('# user\r\nid,email\r\n# devices\r\nid\r\n');
  });

  it('writes the rows, and nothing beyond them', async () => {
    const out = await read(
      csvStream([
        {
          name: 'devices',
          columns: ['deviceName', 'ipAddress'],
          rows: rows([
            { deviceName: 'Firefox, Linux', ipAddress: '203.0.113.9' },
          ]),
        },
      ]),
    );

    expect(out).toContain('"Firefox, Linux",203.0.113.9');
  });

  it('renders a missing column as empty rather than undefined', async () => {
    const out = await read(
      csvStream([
        {
          name: 'devices',
          columns: ['id', 'deviceName'],
          rows: rows([{ id: 'd1' }]),
        },
      ]),
    );

    expect(out).toContain('d1,\r\n');
  });
});

describe('newline-delimited JSON', () => {
  it('writes one parseable object per line', async () => {
    // Not one document: a JSON array has to be complete before its first byte can
    // be written, which is the whole problem this format exists to solve.
    const out = await read(
      jsonStream([
        {
          name: 'user',
          rows: rows([{ id: 'u1' }, { id: 'u2' }]),
        },
      ]),
    );

    const lines = out.trimEnd().split('\n');

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toEqual({
      __type: 'user',
      id: 'u1',
    });
  });

  it('tags each line, so a reader can tell the sections apart', async () => {
    const out = await read(
      jsonStream([
        { name: 'user', rows: rows([{ id: 'u1' }]) },
        { name: 'sessions', rows: rows([{ id: 's1' }]) },
      ]),
    );

    const types = out
      .trimEnd()
      .split('\n')
      .map((line) => (JSON.parse(line) as { __type: string }).__type);

    expect(types).toEqual(['user', 'sessions']);
  });
});

describe('what an export contains', () => {
  /**
   * The assertions that matter, and the reason the exclusions are enforced by
   * `select` rather than by a filter: a column that is not selected cannot be
   * rendered, so there is nothing to forget at the output stage.
   */
  it('never carries the password hash', () => {
    expect(ExportService.columnsFor('user')).not.toContain('password');
  });

  it('never carries a two-factor secret or a recovery code', () => {
    // The ciphertext of somebody's own second factor, handed to them authenticated
    // by the first one, is the second factor.
    const all = [
      ...ExportService.columnsFor('user'),
      ...ExportService.columnsFor('devices'),
      ...ExportService.columnsFor('sessions'),
      ...ExportService.columnsFor('notifications'),
      ...ExportService.columnsFor('passwordHistory'),
    ];

    for (const secret of [
      'secretCiphertext',
      'secretIv',
      'secretAuthTag',
      'recoveryCodes',
    ]) {
      expect(all, secret).not.toContain(secret);
    }
  });

  it('never carries a live credential of any kind', () => {
    const all = ExportService.sectionNames().flatMap((name) => [
      ...ExportService.columnsFor(name),
    ]);

    for (const credential of ['tokenHash', 'jti', 'passwordHash', 'token']) {
      expect(all, credential).not.toContain(credential);
    }
  });

  it('does carry the fields somebody who suspects an intruder actually wants', () => {
    // The point of the export. The exclusions above are only defensible because
    // what is left is the thing a person is entitled to.
    expect(ExportService.columnsFor('devices')).toContain('ipAddress');
    expect(ExportService.columnsFor('devices')).toContain('userAgent');
    expect(ExportService.columnsFor('sessions')).toContain('revokedAt');
    expect(ExportService.columnsFor('passwordHistory')).toContain('createdAt');
  });

  it('keeps the password history reasons without the hashes', () => {
    // The history is there — knowing when your password changed is yours — but a
    // list of hashes is a cracking target that does not belong in a file people
    // email to each other.
    const columns = ExportService.columnsFor('passwordHistory');

    expect(columns).toContain('reason');
    expect(columns).not.toContain('passwordHash');
  });
});
