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
 *
 * **The corpus holds every command that changes data.** Not the two that are
 * famous — the whole family, because a filter that blocks `DROP TABLE` and
 * lets `UPDATE users SET role = 'super_admin'` through has not blocked
 * anything. A payload that changes a row is short, and it is the shortest
 * thing anybody writes when they are trying to find out whether a search box
 * can be talked into running SQL.
 */
export const INJECTION_CORPUS: readonly string[] = [
  // The classic: a quote that ends the literal and a condition that is always
  // true.
  "' OR 1=1 --",
  "admin'--",
  "1' OR '1'='1",
  "' UNION SELECT password FROM users --",

  // Reading somebody else's data.
  'SELECT * FROM refresh_tokens;',
  'SELECT password FROM users;',
  "COPY (SELECT 1) TO PROGRAM 'curl example.com';",

  // Inserting, updating and deleting.
  "INSERT INTO users (email, password) VALUES ('a@x.com', 'x');",
  "UPDATE users SET role = 'super_admin' WHERE email = 'a@x.com';",
  "UPDATE users SET password = 'x' WHERE id = '1';",
  "DELETE FROM users WHERE role = 'admin';",
  'DELETE FROM audit_logs WHERE 1=1;',
  "MERGE INTO users USING (SELECT 1) s ON true WHEN MATCHED THEN UPDATE SET role = 'super_admin';",
  "UPSERT INTO users (email) VALUES ('a@x.com');",
  "COPY users FROM '/etc/passwd';",
  "COPY users TO PROGRAM 'curl example.com';",

  // Creating and changing the schema.
  'CREATE TABLE pwned (id int);',
  'CREATE OR REPLACE FUNCTION pwned() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;',
  'CREATE INDEX pwned ON users (password);',
  'ALTER TABLE users ADD COLUMN is_super boolean DEFAULT true;',
  "ALTER TABLE users ALTER COLUMN role SET DEFAULT 'super_admin';",
  'ALTER TABLE users RENAME TO users_backup;',
  'ALTER TABLE users DROP COLUMN password;',

  // Dropping and emptying.
  'DROP TABLE users;',
  'DROP TABLE audit_logs;',
  'DROP TABLE users CASCADE;',
  'DROP TABLE IF EXISTS users, audit_logs, refresh_tokens CASCADE;',
  // Quoted and schema-qualified, because that is how a payload that has been
  // copied out of a console looks.
  'DROP TABLE "public"."users";',
  'DROP SCHEMA public CASCADE;',
  'DROP DATABASE boilerplate;',
  'DROP INDEX IDX_users_email;',
  'DROP TRIGGER users_audit;',
  'TRUNCATE TABLE users;',
  'TRUNCATE TABLE "users" CASCADE;',
  'TRUNCATE TABLE audit_logs RESTART IDENTITY CASCADE;',
  'TRUNCATE users, audit_logs, refresh_tokens, user_devices;',
  'TRUNCATE refresh_tokens CASCADE;',

  // Permissions and roles.
  'GRANT ALL PRIVILEGES ON DATABASE boilerplate TO public;',
  'REVOKE ALL ON users FROM PUBLIC;',
  'ALTER ROLE admin SUPERUSER;',
  'ALTER TABLE users OWNER TO postgres;',

  // Running something.
  'EXECUTE pwned();',
  'CALL pwned();',
  "DO $$ BEGIN EXECUTE 'DROP TABLE users'; END $$;",
  'SELECT pg_sleep(10);',

  // Changing the session or the server.
  'SET search_path TO public;',
  'SET ROLE admin;',
  'RESET ALL;',
  'VACUUM FULL users;',
  'REINDEX TABLE users;',
  'CLUSTER users USING IDX_users_email;',
  'REFRESH MATERIALIZED VIEW users;',
  'REASSIGN OWNED BY admin TO postgres;',
  "COMMENT ON TABLE users IS 'pwned';",
  "SECURITY LABEL ON TABLE users IS 'pwned';",
  'CHECKPOINT;',
  'DISCARD ALL;',
  'LOCK TABLE users IN ACCESS EXCLUSIVE MODE;',

  // Transactions, prepared statements and the rest.
  'BEGIN; DROP TABLE users; COMMIT;',
  'PREPARE p AS SELECT 1; EXECUTE p;',
  'DEALLOCATE p;',
  'LISTEN channel;',
  'UNLISTEN channel;',
  'NOTIFY channel;',
  'ANALYZE users;',
  'SAVEPOINT s; ROLLBACK TO s;',

  // The same, smuggled past a filter that expects one value.
  '; DROP TABLE users; --',
  '; TRUNCATE TABLE users; --',
  "' OR 1=1; DROP TABLE users; --",
  "') OR ('1'='1'; TRUNCATE TABLE audit_logs; --",

  // The characters that mean something to a LIKE pattern, which have to be
  // literal rather than wildcards.
  '100%',
  'a_b',
  'back\\slash',
];

/**
 * The commands that are statements.
 *
 * **Every one of them changes the database, the server or the permissions —
 * and a couple of them only read.** A translated fragment that contains one of
 * these is not a filter any more: it is a statement. A statement that changes a
 * row is the danger, and a statement that reads somebody else's row is almost
 * as bad, so the list holds both.
 *
 * **It is the list the corpus is built from, and the list the SQL is checked
 * against.** A translated fragment may contain none of them, ever.
 */
export const STATEMENT_COMMANDS: readonly string[] = [
  'insert',
  'update',
  'delete',
  'merge',
  'upsert',
  'copy',
  'create',
  'alter',
  'drop',
  'truncate',
  'grant',
  'revoke',
  'execute',
  'call',
  'do',
  'set',
  'reset',
  'vacuum',
  'reindex',
  'cluster',
  'refresh',
  'reassign',
  'comment',
  'security',
  'lock',
  'checkpoint',
  'discard',
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'prepare',
  'deallocate',
  'listen',
  'unlisten',
  'notify',
  'analyze',
  'analyse',
  'import',
  'load',
  'select',
  'with',
];

/**
 * The words a translated fragment is allowed to contain.
 *
 * **Everything else is a statement, and a statement changes something.** A
 * search fragment is a boolean expression over columns and parameters: it is
 * never a statement, so it cannot insert, update, delete, drop, truncate or
 * grant. The list is the whole of the vocabulary, and a word outside it means
 * something reached the SQL that should not have.
 */
const ALLOWED_SQL_WORDS: ReadonlySet<string> = new Set([
  'and',
  'or',
  'not',
  'is',
  'null',
  'ilike',
  'like',
  'escape',
  'true',
  'false',
  'between',
]);

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
  assertNoStatementCanReachTheSql(options);
  assertTheSqlIsAPredicate(options);
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
      `${field}:"${asQueryText(value)}"`,
    );

    assertNoValueInTheSql(options, translated, value);
    assertOnlyDeclaredColumns(options, translated);
    assertTheValueWasBound(options, translated, value);
  }
}

/**
 * No statement can reach the SQL.
 *
 * **Every command in the family, not the two that are famous.** A filter that
 * blocks `DROP TABLE` and lets `UPDATE users SET role = 'super_admin'` through
 * has not blocked anything, and the payload that changes a row is just as short
 * as the one that drops a table.
 *
 * The check is on the output: the word must not appear in the SQL at all. It is
 * a stronger claim than "the value is not in the SQL", because it holds for
 * every value and not only for the ones somebody thought of.
 */
export function assertNoStatementCanReachTheSql(
  options: SearchKitOptions,
): void {
  const field = options.registry.names()[0];

  if (field === undefined) {
    throw new Error('The registry has no fields, so there is nothing to test.');
  }

  for (const value of INJECTION_CORPUS) {
    const translated = translate(
      'data change',
      options,
      `${field}:"${asQueryText(value)}"`,
    );

    for (const word of sqlWords(translated.sql)) {
      if (STATEMENT_COMMANDS.includes(word)) {
        throw new Error(
          `The command "${word}" reached the SQL. A search fragment is a ` +
            'boolean expression over columns and parameters — it is never a ' +
            'statement, and a statement changes something.',
        );
      }
    }
  }
}

/**
 * The SQL is a predicate, and never a statement.
 *
 * **The whole of the claim, in one assertion.** A translated fragment may
 * contain a column name, a parameter, a comparison and a boolean operator, and
 * nothing else. A word outside that vocabulary is a statement, and a statement
 * is something that changes the database. A semicolon is the same thing: it is
 * how a second statement begins.
 *
 * This is the structural version of the corpus, and it is the one that holds
 * for a payload nobody thought of — the corpus proves the payloads we know
 * about, and this proves there is no shape they could take.
 */
export function assertTheSqlIsAPredicate(options: SearchKitOptions): void {
  const field = options.registry.names()[0];

  if (field === undefined) {
    throw new Error('The registry has no fields, so there is nothing to test.');
  }

  for (const value of [...INJECTION_CORPUS, 'value']) {
    const translated = translate(
      'predicate',
      options,
      `${field}:"${asQueryText(value)}"`,
    );

    if (translated.sql.includes(';')) {
      throw new Error(
        'The SQL contains a semicolon, which is how a second statement ' +
          'begins. A search fragment is one boolean expression and nothing ' +
          'follows it.',
      );
    }

    for (const word of sqlWords(translated.sql)) {
      if (!ALLOWED_SQL_WORDS.has(word)) {
        throw new Error(
          `The SQL contains the word "${word}", which is not part of the ` +
            `vocabulary a filter may use: ${[...ALLOWED_SQL_WORDS].join(', ')}. ` +
            'A word outside it is a statement, and a statement changes ' +
            'something.',
        );
      }
    }
  }
}

/**
 * The words in a piece of SQL.
 *
 * **The quoted identifiers and the parameter names are not words.** A column
 * name is a name this application wrote, and a parameter is a placeholder;
 * neither is a word of the statement, and counting them would make the check
 * about the names rather than about the statement.
 */
function sqlWords(sql: string): string[] {
  const withoutNames = sql.replace(/"[^"]*"/g, ' ').replace(/:\w+/g, ' ');

  return [...withoutNames.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((match) =>
    (match[0] ?? '').toLowerCase(),
  );
}

/**
 * A value as it is written in a query.
 *
 * **The quotes and the backslashes are escaped**, because they are the two
 * characters the query language gives a meaning to. Stripping them would test a
 * value the client never sent, and a test of a value nobody can send proves
 * nothing.
 */
function asQueryText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
