import { BadRequestException } from '@nestjs/common';

/**
 * What a cursor carries: the value the previous page ended on, and the id of the
 * row that ended it.
 *
 * **The id is not decoration.** Ordering by `createdAt` alone is not a total
 * order — two rows created inside the same transaction carry the same timestamp,
 * and a great many of them do. Without a tie-break, page two re-reads the boundary
 * row, or skips it, depending on which side of the boundary the plan happens to
 * fall. Adding the primary key makes the order total, which is what turns "probably
 * correct" into "the same answer every time".
 *
 * The id is also what makes the cursor opaque-safe: it is not a number the caller
 * could increment or a timestamp they could edit to walk the table by hand.
 */
export interface Cursor {
  /** The sort value the previous page's last row carried. */
  value: string;
  /** The id of the previous page's last row. */
  id: string;
}

/** Bumped if the shape ever changes, so an old cursor is refused not misread. */
const CURSOR_VERSION = 1;

interface CursorPayload {
  v: number;
  /** Sort value. */
  s: string;
  /** Id. */
  i: string;
}

/**
 * Encodes a cursor as one opaque base64url token.
 *
 * **Opaque on purpose.** The client is handed `nextCursor` and must hand it back
 * verbatim; it is not meant to be read, constructed or edited. That is a contract,
 * not obscurity — the alternative is a cursor made of `createdAt` and `id` that
 * every client would grow its own arithmetic for, and one that arithmetic mistake
 * would silently turn into a skipped page.
 *
 * base64url rather than base64, so a cursor survives a query string, a JSON body
 * and a URL path without escaping. `.trim()` because a client that reads the
 * cursor out of the JSON, copies it through a spreadsheet, or assembles the query
 * string by hand routinely produces a trailing space, and that is a formatting
 * accident rather than a bad request.
 */
export function encodeCursor(cursor: Cursor): string {
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    s: cursor.value,
    i: cursor.id,
  };

  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor, or refuses it.
 *
 * **A malformed cursor is a 400, never a silent first page.** Silently ignoring
 * it would hand back page one, which is a correct-looking response to a request
 * for page four, and the client would render duplicates or an empty list and
 * report it as "no results". Refusing says the cursor is wrong, which is the thing
 * a client author can act on.
 *
 * The checks are exhaustive rather than optimistic: a payload that parses as JSON
 * but is not the shape we wrote — an array, a number, a hand-built object with the
 * keys in a different order — must not produce a cursor whose `value` is
 * `undefined`, because that value ends up in a SQL comparison where `undefined`
 * becomes `NULL` and silently matches nothing.
 */
export function decodeCursor(
  raw: string | undefined | null,
): Cursor | undefined {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(raw.trim(), 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException(
      'Malformed cursor. Cursors are opaque — use the nextCursor value from a previous response unmodified.',
    );
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as CursorPayload).v !== CURSOR_VERSION ||
    typeof (parsed as CursorPayload).s !== 'string' ||
    typeof (parsed as CursorPayload).i !== 'string' ||
    (parsed as CursorPayload).i === ''
  ) {
    throw new BadRequestException(
      'Unsupported cursor. It was not produced by this API, or it predates a change to the cursor format.',
    );
  }

  return {
    value: (parsed as CursorPayload).s,
    id: (parsed as CursorPayload).i,
  };
}
