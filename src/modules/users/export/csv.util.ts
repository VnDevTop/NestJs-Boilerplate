import { Readable } from 'node:stream';

/**
 * CSV writing, one value at a time.
 *
 * **A stream, not a string.** The export is a response body, and the only reason to
 * build it in memory is that it is easier. For an account with a decade of sessions
 * that is a decade of rows in the heap, on the event loop, for every export — and
 * the endpoint that exists to satisfy a data-subject request is the last place that
 * should fall over under load.
 *
 * **RFC 4180 escaping, applied per value.** A field is quoted if it contains a
 * comma, a quote, a newline or a carriage return, and an embedded quote is doubled.
 * This is not decoration: a session's `userAgent` is attacker-controlled and
 * routinely contains a comma, so an unescaped export is not merely malformed — it
 * puts attacker-chosen columns in a file an operator opens in a spreadsheet.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with a tab. That is the CSV injection
 * every spreadsheet application has shipped a fix for at some point, and a user
 * agent beginning with `=cmd|` is a value a stranger chose. Prefixing changes what
 * the cell renders as and not what the account holder sees.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  let text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);

  // Prefix first, quote second. The other order puts the tab outside the quotes,
  // so the value still opens with `=` the moment a spreadsheet parses it — and a
  // quoted CSV field beginning with `=` is still executed by Excel and LibreOffice.
  // Prefix-then-quote leaves a tab as the first character *inside* the quotes.
  if (/^[=+\-@]/.test(text)) {
    text = `\t${text}`;
  }

  if (
    text.includes(',') ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r')
  ) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

/** One CSV row, terminated with CRLF as RFC 4180 specifies. */
export function csvRow(values: readonly unknown[]): string {
  return `${values.map(csvField).join(',')}\r\n`;
}

/** One section of an export: a name, its columns, and its rows. */
export interface CsvSection {
  name: string;
  columns: readonly string[];
  rows: AsyncIterable<Record<string, unknown>>;
}

/**
 * A multi-section CSV as a readable stream.
 *
 * Each section is announced by a `# name` line and then its own header row. A CSV
 * holding five differently-shaped tables has to say which is which, and a reader
 * meeting `revokedReason` in the middle of a file has no way to tell whether it
 * arrived in the wrong section or in the wrong file.
 *
 * Pull-based rather than pushed, so a slow database cursor and a slow client cannot
 * each buffer for the other. That is what makes this streamed rather than
 * collected-then-written: the next row is read only when the previous has gone.
 */
export function csvStream(sections: readonly CsvSection[]): Readable {
  return Readable.from(
    (async function* () {
      for (const section of sections) {
        yield `# ${section.name}\r\n`;
        yield csvRow(section.columns);

        for await (const row of section.rows) {
          yield csvRow(section.columns.map((column) => row[column]));
        }
      }
    })(),
  );
}

/**
 * A multi-section export as newline-delimited JSON.
 *
 * **Not a JSON document.** An array has to be complete before its first byte can be
 * written, which is the whole problem, and a caller that reaches for `JSON.parse`
 * on a large export should get an error rather than an out-of-memory crash on the
 * accounts with the most data.
 *
 * `__type` on every line is what makes the stream readable in something like `jq`,
 * where a run of same-shaped objects is ambiguous the moment two of them differ.
 * Each line is independently parseable, so a truncated file is a file with fewer
 * rows rather than a file that fails entirely.
 */
export function jsonStream(
  sections: readonly {
    name: string;
    rows: AsyncIterable<Record<string, unknown>>;
  }[],
): Readable {
  return Readable.from(
    (async function* () {
      for (const section of sections) {
        for await (const row of section.rows) {
          yield `${JSON.stringify({ __type: section.name, ...row })}\n`;
        }
      }
    })(),
  );
}
