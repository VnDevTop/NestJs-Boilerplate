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

/**
 * A query the backend cannot express.
 *
 * **Not the same as a field that cannot do it.** A fuzzy term is a perfectly
 * good term; it is the *backend* that cannot answer it, and saying so is
 * better than answering a different question.
 */
export class UnsupportedOperationError extends Error {
  constructor(
    /** What was asked for, in the client's words. */
    readonly operation: string,
    /** Why it cannot be done here. */
    readonly reason: string,
  ) {
    super(`The search operation "${operation}" is not supported: ${reason}.`);

    this.name = 'UnsupportedOperationError';
  }
}

/**
 * A value that is not a value of the field's type.
 *
 * **Refused here rather than left to the database.** Postgres would answer a
 * comparison between a number and a word with an error about a type it cannot
 * coerce, and the client would be told about a type rather than about the
 * value they typed.
 */
export class InvalidSearchValueError extends Error {
  constructor(
    /** The field the value was for. */
    readonly field: string,
    /** The value that was typed. */
    readonly value: string,
    /** What the field's type expects. */
    readonly expected: string,
  ) {
    super(
      `"${value}" is not a valid ${expected} for the search field "${field}".`,
    );

    this.name = 'InvalidSearchValueError';
  }
}
