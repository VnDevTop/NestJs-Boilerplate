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

/**
 * A field the search does not have.
 *
 * **The message lists the valid names.** A client that typed `emial:ada` needs
 * to know that `email` is the name, and a message saying "unknown field" is a
 * message that sends them to the documentation. The valid names are the whole
 * point of the allow-list, and this is where they are shown.
 */
export class UnknownFieldError extends Error {
  constructor(
    /** The field that was asked for. */
    readonly field: string,
    /** The fields that do exist. */
    readonly valid: readonly string[],
  ) {
    super(
      `Unknown search field "${field}". ` +
        `Searchable fields: ${valid.length === 0 ? '(none)' : valid.join(', ')}.`,
    );

    this.name = 'UnknownFieldError';
  }
}

/**
 * A field that exists but does not support what was asked of it.
 *
 * **Separate from `UnknownFieldError` because the answer is different.** An
 * unknown field is a typo; a field that is not searchable is a field the
 * entity's author decided not to expose, and the message should say so rather
 * than sending the client looking for a spelling.
 */
export class UnsupportedFieldError extends Error {
  constructor(
    /** The field that was asked for. */
    readonly field: string,
    /** Why it cannot do what was asked, in words. */
    readonly reason: string,
  ) {
    super(`The search field "${field}" ${reason}.`);

    this.name = 'UnsupportedFieldError';
  }
}
