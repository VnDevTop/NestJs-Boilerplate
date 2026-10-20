/**
 * The one error the search layer throws.
 *
 * **Every failure a caller can cause is this error.** A malformed query is a
 * client mistake, and a client mistake must be a 400 with a message that says
 * which part of the query was wrong and where. A `TypeError` from deep inside
 * the parser is a 500 for a request that was merely wrong, and it says nothing
 * about what to fix.
 *
 * The position is the offset into the source, so the message can point at the
 * character that was wrong rather than at the query as a whole.
 */
export class SearchParseError extends Error {
  constructor(
    message: string,
    /** The offset into the source where the problem is. */
    readonly position: number,
    /** The query that failed, for the message. */
    readonly source?: string,
  ) {
    super(
      source === undefined
        ? `${message} (at position ${position})`
        : `${message} (at position ${position} in "${source}")`,
    );

    this.name = 'SearchParseError';
  }
}
