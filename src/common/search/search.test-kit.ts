import type { SearchQuery } from './ast.js';
import {
  InvalidSearchValueError,
  SearchParseError,
  UnknownFieldError,
  UnsupportedFieldError,
  UnsupportedOperationError,
} from './errors.js';
import type { SearchFieldRegistry } from './field-registry.js';
import { parseSearchQuery } from './parser.js';
import {
  translateToSql,
  type TranslatedQuery,
} from './translators/postgres.js';

/**
 * The assertions every entity's search has to pass.
 *
 * **Reusable, because the properties are the same for every entity.** What
 * differs between entities is the field map, and every one of these assertions
 * is about the field map: that the allow-list is the only way into the SQL,
 * that no value ever becomes text, and that a field nobody declared is an error
 * rather than a dropped clause.
 *
 * **The kit asserts rather than registers.** It throws on a failure, and a
 * spec calls it from an `it` — so the kit does not import a test framework,
 * and a file that ships in the build carries no dependency on one.
 */
export interface SearchKitOptions {
  /** The field map under test. */
  readonly registry: SearchFieldRegistry;
  /**
   * The translator under test.
   *
   * The Postgres one by default, because that is the one whose output can
   * change the meaning of a statement.
   */
  readonly translate?: (
    query: SearchQuery,
    registry: SearchFieldRegistry,
  ) => TranslatedQuery;
}

/**
 * The values a client might send, and which must never become SQL text.
 *
 * **Every one of them is a value, not a query.** A value that reached the SQL
 * as text would be a client who can read the database, and a search box is the
 * one place a client types whatever they like.
 */
export const INJECTION_CORPUS: readonly string[] = [
  "' OR 1=1 --",
  '; DROP TABLE users; --',
  "admin'--",
  "1' OR '1'='1",
  "' UNION SELECT password FROM users --",
  '100%',
  'a_b',
  'back\\slash',
];

/**
 * The errors a translator is allowed to throw.
 *
 * **A plain `Error` is not one of them.** It means the translator found
 * something it did not expect, and a client mistake must not turn into a 500.
 */
const KNOWN_ERRORS = [
  SearchParseError,
  UnknownFieldError,
  UnsupportedFieldError,
  UnsupportedOperationError,
  InvalidSearchValueError,
];

/**
 * Runs every assertion.
 *
 * **One call, so an entity's spec is one line.** The assertions are exported
 * separately as well, for a spec that wants to name them one by one.
 */
export function runSearchTestKit(options: SearchKitOptions): void {
  assertGoldenCases(options);
  assertUnknownFieldsAreRefused(options);
  assertInjectionCorpusNeverReachesTheSql(options);
  assertFuzzCorpusStaysInsideTheAllowList(options);
}

/**
 * The golden cases, derived from the registry.
 *
 * **Derived rather than written down**, because the fields differ between
 * entities and a case that named one of them would be a case about that
 * entity rather than about the search.
 */
export function assertGoldenCases(options: SearchKitOptions): void {
  const { registry } = options;

  for (const [name, field] of registry.entries()) {
    const value = sampleValue(field.type);

    if (field.searchable) {
      // A term on the field has to name the field's column, and the value has
      // to be a parameter.
      const translated = golden(
        `a term on ${name}`,
        options,
        `${name}:${value}`,
      );

      assertOnlyDeclaredColumns(options, translated);
      assertNoValueInTheSql(options, translated, value);
      assertSomethingWasBound(options, translated);
    }

    if (field.filterable && field.type !== 'boolean') {
      // A range has to name the column and bind both bounds.
      const translated = golden(
        `a range on ${name}`,
        options,
        `${name}:[${value} TO ${value}]`,
      );

      assertOnlyDeclaredColumns(options, translated);
      assertSomethingWasBound(options, translated);
    }
  }
}

/**
 * A golden case, and the case's name if it is not a query at all.
 *
 * **The name is in the failure.** A golden case that does not parse is a bug
 * in the case, and a bug that says only "unexpected token" is a bug nobody can
 * find.
 */
function golden(
  what: string,
  options: SearchKitOptions,
  query: string,
): TranslatedQuery {
  try {
    return translate(what, options, query);
  } catch (error) {
    if (error instanceof SearchParseError) {
      throw new Error(
        `The golden case "${what}" (${query}) is not a query the parser ` +
          `accepts: ${String(error)}`,
      );
    }

    throw error;
  }
}

/**
 * A value a field of this type accepts.
 *
 * **Per type, because the golden cases have to be ones the translator will
 * accept.** A date range bounded by "1" is refused — correctly — and a case
 * that is refused teaches nothing about the entity.
 */
function sampleValue(type: string): string {
  switch (type) {
    case 'number':
      return '1';

    case 'date':
      return '2026-01-01T00:00:00Z';

    case 'boolean':
      return 'true';

    case 'uuid':
      return '00000000-0000-4000-8000-000000000000';

    default:
      return 'value';
  }
}

/**
 * An undeclared field is an error, and the error names the fields that are.
 *
 * **Never a dropped clause.** A dropped field is a filter the client believes
 * is applied and is not, and the result is a page of rows nobody asked for.
 */
export function assertUnknownFieldsAreRefused(options: SearchKitOptions): void {
  const unknown = 'fieldThatDoesNotExist';

  try {
    translate('unknown field', options, `${unknown}:value`);

    throw new Error(
      `The translator accepted the undeclared field "${unknown}". A field that ` +
        'is not declared has to be an error, not a dropped clause.',
    );
  } catch (error) {
    if (error instanceof UnknownFieldError) {
      // The names are in the message on purpose: a client that typed `emial`
      // needs to be told that `email` is the name.
      if (!error.message.includes(unknown)) {
        throw new Error(
          'The error for an undeclared field does not name the field that was ' +
            'asked for.',
        );
      }

      return;
    }

    throw error;
  }
}

/**
 * Nothing a client types reaches the SQL as text.
 *
 * **The property the phase exists for.** A search is a client's input, and a
 * client's input that reaches SQL as text is a client who can read the
 * database.
 */
export function assertInjectionCorpusNeverReachesTheSql(
  options: SearchKitOptions,
): void {
  const field = options.registry.names()[0];

  if (field === undefined) {
    throw new Error('The registry has no fields, so there is nothing to test.');
  }

  for (const value of INJECTION_CORPUS) {
    // Quoted, so the value stays one value: unquoted, the spaces in it would
    // split it into several terms, which is safe but is not the test.
    const translated = translate(
      'injection',
      options,
      `${field}:"${value.replace(/"/g, '')}"`,
    );

    assertNoValueInTheSql(options, translated, value);
    assertOnlyDeclaredColumns(options, translated);
    assertTheValueWasBound(options, translated, value);
  }
}

/**
 * The value reached the parameters.
 *
 * **Not in the SQL, and not nowhere.** A value that is in neither was dropped,
 * and a dropped value is a filter the client believes is applied and is not.
 *
 * The parts are checked rather than the whole value, because the value is
 * escaped on its way into the parameter: `a_b` is bound as `a\_b`, and the
 * whole string is not in there.
 */
function assertTheValueWasBound(
  options: SearchKitOptions,
  translated: TranslatedQuery,
  value: string,
): void {
  const parts = value.split(/[%_\\]/).filter((part) => part !== '');

  if (parts.length === 0) {
    return;
  }

  const bound = Object.values(translated.parameters).map((parameter) =>
    String(parameter),
  );

  for (const part of parts) {
    if (!bound.some((parameter) => parameter.includes(part))) {
      throw new Error(
        `The value "${value}" is in neither the SQL nor the parameters, so it ` +
          'was dropped — and a dropped value is a filter the client believes ' +
          'is applied and is not.',
      );
    }
  }
}

/**
 * Nonsense in, a sensible answer out.
 *
 * **Every failure is a failure the application knows how to answer.** A plain
 * `Error` means the translator met something it did not expect, and a client
 * mistake that turns into a 500 is a bug in the translator.
 */
export function assertFuzzCorpusStaysInsideTheAllowList(
  options: SearchKitOptions,
): void {
  for (const query of fuzzCorpus()) {
    let translated: TranslatedQuery | undefined;

    try {
      translated = translate('fuzz', options, query);
    } catch (error) {
      if (!isKnownError(error)) {
        throw new Error(
          `The translator threw an unexpected error for the query "${query}": ` +
            `${String(error)}. A client mistake has to be one of the errors the ` +
            'application knows how to answer.',
        );
      }

      continue;
    }

    assertOnlyDeclaredColumns(options, translated);
  }
}

/**
 * The translator under test, with the query parsed first.
 *
 * **A parse error is left alone.** It is one of the errors the application
 * knows how to answer, and the fuzz corpus is mostly queries that do not parse
 * — which is the point of it.
 */
function translate(
  _what: string,
  options: SearchKitOptions,
  query: string,
): TranslatedQuery {
  const translate =
    options.translate ??
    ((parsed: SearchQuery, registry: SearchFieldRegistry) =>
      translateToSql(parsed, registry));

  return translate(parseSearchQuery(query), options.registry);
}

/**
 * Every identifier the SQL names is one the registry declares.
 *
 * **The allow-list, checked from the output rather than from the code.** The
 * identifiers are the quoted names in the SQL, and there is nothing else quoted
 * in it — the parameters are named with a colon and the escape character is a
 * single quote — so this is the whole set of names that reached the statement.
 */
function assertOnlyDeclaredColumns(
  options: SearchKitOptions,
  translated: TranslatedQuery,
): void {
  const declared = new Set(options.registry.columns());

  for (const identifier of quotedIdentifiers(translated.sql)) {
    if (!declared.has(identifier)) {
      throw new Error(
        `The SQL names "${identifier}", which is not a column the registry ` +
          `declares: ${[...declared].join(', ')}. Only a declared column may ` +
          'reach a statement.',
      );
    }
  }
}

/** The values a client sent are in the parameters and nowhere else. */
function assertNoValueInTheSql(
  options: SearchKitOptions,
  translated: TranslatedQuery,
  value: string,
): void {
  if (translated.sql.includes(value)) {
    throw new Error(
      `The value "${value}" reached the SQL as text. A value that is in the ` +
        'statement is a value that can change what the statement means.',
    );
  }
}

/**
 * Something was bound.
 *
 * **A query that binds nothing has no value in it**, and a case that binds
 * nothing is a case that proved nothing.
 */
function assertSomethingWasBound(
  options: SearchKitOptions,
  translated: TranslatedQuery,
): void {
  if (Object.keys(translated.parameters).length === 0) {
    throw new Error(
      'The translation bound no values, so the case proved nothing: a query ' +
        'with no value in it is not a query.',
    );
  }
}

/** The quoted identifiers in a piece of SQL. */
function quotedIdentifiers(sql: string): string[] {
  return [...sql.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '');
}

/** True for an error the application knows how to answer. */
function isKnownError(error: unknown): boolean {
  return KNOWN_ERRORS.some((known) => error instanceof known);
}

/**
 * Nonsense, deterministically.
 *
 * **Seeded, so a failure is reproducible.** A fuzz that fails once and not
 * again is a fuzz that taught nobody anything, and a test that cannot be
 * re-run is a test nobody will re-run.
 */
export function fuzzCorpus(count = 200): string[] {
  let seed = 0x2f6e2b1;

  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;

    return seed;
  };

  const pieces = [
    'a',
    'b',
    'email:',
    'field:',
    'AND',
    'OR',
    'NOT',
    '(',
    ')',
    '"x"',
    '[1 TO 2]',
    '{1 TO 2}',
    '~',
    '~2',
    '^2',
    ':',
    '*',
    '?',
    '\\',
    '-',
    '>',
  ];

  const queries: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const length = 1 + (next() % 8);
    let query = '';

    for (let part = 0; part < length; part += 1) {
      query += pieces[next() % pieces.length] ?? 'a';

      if (next() % 3 === 0) {
        query += ' ';
      }
    }

    queries.push(query);
  }

  return queries;
}
