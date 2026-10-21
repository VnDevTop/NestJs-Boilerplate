import type { SearchQuery } from '../ast.js';
import type { SearchFieldRegistry } from '../field-registry.js';
import type { TranslatedQuery } from './postgres.js';

/**
 * A translator that answers whatever it was told to.
 *
 * **For testing the caller rather than the translation.** A service that
 * searches needs a translator, and a test of that service needs one that does
 * not need a database. This records every query it is given and answers with a
 * fixed result, so a test can assert on what the service asked for.
 *
 * It is a translator and not a stub of the service's dependency, so the
 * service under test is written against the same interface it will use in
 * production.
 */
export class MockSearchTranslator {
  /** Every query it was given, in the order they arrived. */
  readonly queries: SearchQuery[] = [];

  private readonly result: TranslatedQuery;

  constructor(result: TranslatedQuery = { sql: 'TRUE', parameters: {} }) {
    this.result = result;
  }

  /** The answer, and the query is recorded. */
  translate(
    query: SearchQuery,
    _registry: SearchFieldRegistry,
  ): TranslatedQuery {
    this.queries.push(query);

    return this.result;
  }

  /** The last query it was given, for a test that only cares about the latest. */
  get lastQuery(): SearchQuery | undefined {
    return this.queries[this.queries.length - 1];
  }
}
