import { describe, expect, it } from 'vitest';

import { SearchFieldRegistry, type SearchField } from './field-registry.js';
import { parseSearchQuery } from './parser.js';
import {
  assertFuzzCorpusStaysInsideTheAllowList,
  assertGoldenCases,
  assertInjectionCorpusNeverReachesTheSql,
  assertUnknownFieldsAreRefused,
  fuzzCorpus,
  INJECTION_CORPUS,
  runSearchTestKit,
} from './search.test-kit.js';
import { MockSearchTranslator } from './translators/mock.js';
import { translateToSql } from './translators/postgres.js';

/**
 * The kit, tested against a fictional entity.
 *
 * **A fictional one on purpose.** The kit is what every entity's search uses,
 * so the kit's own test cannot use a real entity: it would fail when the real
 * entity's field map changed, and the failure would be about the entity rather
 * than about the kit. This is the same reasoning as the query layer's
 * `adding-a-route.spec.ts`.
 */
const fields: Record<string, SearchField> = {
  email: {
    type: 'text',
    searchable: true,
    filterable: true,
    sortable: true,
    weight: 1,
    column: 'email',
  },
  role: {
    type: 'keyword',
    searchable: true,
    filterable: true,
    sortable: true,
    weight: 0.6,
    column: 'role',
  },
  age: {
    type: 'number',
    searchable: true,
    filterable: true,
    sortable: true,
    weight: 0.2,
    column: 'age',
  },
  createdAt: {
    type: 'date',
    searchable: false,
    filterable: true,
    sortable: true,
    weight: 0.3,
    column: 'createdAt',
  },
  isActive: {
    type: 'boolean',
    searchable: true,
    filterable: true,
    sortable: true,
    weight: 0.1,
    column: 'isActive',
  },
  id: {
    type: 'uuid',
    searchable: true,
    filterable: true,
    sortable: true,
    weight: 0.1,
    column: 'id',
  },
  secret: {
    type: 'text',
    searchable: false,
    filterable: false,
    sortable: false,
    weight: 0,
    column: 'secret',
  },
};

const registry = new SearchFieldRegistry(fields, { defaultField: 'email' });

describe('the search test kit', () => {
  it('passes, against a fictional entity', () => {
    // The whole point: an entity's search spec is one call to this.
    expect(() => runSearchTestKit({ registry })).not.toThrow();
  });

  it('holds the golden cases', () => {
    expect(() => assertGoldenCases({ registry })).not.toThrow();
  });

  it('refuses an undeclared field', () => {
    expect(() => assertUnknownFieldsAreRefused({ registry })).not.toThrow();
  });

  it('keeps the injection corpus out of the SQL', () => {
    expect(() =>
      assertInjectionCorpusNeverReachesTheSql({ registry }),
    ).not.toThrow();
  });

  it('keeps the fuzz corpus inside the allow-list', () => {
    expect(() =>
      assertFuzzCorpusStaysInsideTheAllowList({ registry }),
    ).not.toThrow();
  });
});

/**
 * The kit's assertions, shown failing.
 *
 * **A kit that cannot fail is a kit that proves nothing.** Each of these
 * breaks one of the properties deliberately and shows that the kit notices.
 */
describe('the kit notices', () => {
  it('a translator that puts a value in the SQL', () => {
    const leaky = () => ({
      sql: `"email" ILIKE '%' OR 1=1 --%'`,
      parameters: {},
    });

    expect(() =>
      assertInjectionCorpusNeverReachesTheSql({
        registry,
        translate: leaky,
      }),
    ).toThrow(/reached the SQL as text/);
  });

  it('a translator that names a column the registry does not declare', () => {
    const leaky = () => ({
      sql: '"password" = :p0',
      parameters: { p0: 'x' },
    });

    expect(() =>
      assertFuzzCorpusStaysInsideTheAllowList({
        registry,
        translate: leaky,
      }),
    ).toThrow(/not a column the registry declares/);
  });

  it('a translator that accepts an undeclared field', () => {
    const leaky = () => ({ sql: 'TRUE', parameters: {} });

    expect(() =>
      assertUnknownFieldsAreRefused({ registry, translate: leaky }),
    ).toThrow(/accepted the undeclared field/);
  });

  it('a translator that throws something the application cannot answer', () => {
    const broken = () => {
      throw new TypeError('cannot read property of undefined');
    };

    expect(() =>
      assertFuzzCorpusStaysInsideTheAllowList({
        registry,
        translate: broken,
      }),
    ).toThrow(/unexpected error/);
  });
});

describe('the fuzz corpus', () => {
  it('is the same every time', () => {
    // A fuzz that fails once and not again is a fuzz that taught nobody
    // anything, and a test that cannot be re-run is a test nobody will re-run.
    expect(fuzzCorpus(50)).toEqual(fuzzCorpus(50));
  });

  it('is nonsense, and mostly refused', () => {
    const queries = fuzzCorpus(200);

    expect(queries.length).toBe(200);
    // If every one of them translated, the corpus would not be reaching the
    // interesting part of the grammar.
    expect(queries.length).toBeGreaterThan(10);
  });
});

describe('the injection corpus', () => {
  it('holds values that would change a statement if they were text', () => {
    expect(INJECTION_CORPUS.length).toBeGreaterThan(3);
    expect(INJECTION_CORPUS.some((value) => value.includes("'"))).toBe(true);
  });

  /**
   * The corpus is the test of the corpus.
   *
   * **A payload that drops a table is short**, and it is the shortest thing
   * anybody writes when they are trying to find out whether a search box can be
   * talked into running SQL. So the corpus holds the statements that would do
   * the most damage — and this test is what stops them being quietly dropped
   * from it later.
   */
  it('holds the statements that would destroy the database', () => {
    expect(
      INJECTION_CORPUS.some((value) => /\bdrop\s+table\b/i.test(value)),
    ).toBe(true);
    expect(INJECTION_CORPUS.some((value) => /\btruncate\b/i.test(value))).toBe(
      true,
    );
    expect(
      INJECTION_CORPUS.some((value) => /\bdelete\s+from\b/i.test(value)),
    ).toBe(true);
    expect(
      INJECTION_CORPUS.some((value) => /\balter\s+table\b/i.test(value)),
    ).toBe(true);
  });

  it('holds them against the tables this application has', () => {
    // A payload that names a table that exists is the one somebody would
    // actually write.
    expect(INJECTION_CORPUS.some((value) => /users/i.test(value))).toBe(true);
    expect(INJECTION_CORPUS.some((value) => /audit_logs/i.test(value))).toBe(
      true,
    );
  });
});

describe('the mock translator', () => {
  it('answers with what it was told to', () => {
    const translator = new MockSearchTranslator({
      sql: '"email" = :p0',
      parameters: { p0: 'x' },
    });

    const result = translator.translate(parseSearchQuery('email:x'), registry);

    expect(result.sql).toBe('"email" = :p0');
  });

  it('records what it was asked', () => {
    // A test of a service that searches needs to know what the service asked
    // for, and that is the point of the mock.
    const translator = new MockSearchTranslator();

    translator.translate(parseSearchQuery('email:ada'), registry);
    translator.translate(parseSearchQuery('role:admin'), registry);

    expect(translator.queries).toHaveLength(2);
    expect(translator.lastQuery).toMatchObject({
      type: 'field',
      value: 'admin',
    });
  });
});

describe('the postgres translator, through the kit', () => {
  it('is the translator the kit uses by default', () => {
    const translated = translateToSql(parseSearchQuery('email:ada'), registry);

    expect(translated.sql).toContain('"email"');
  });
});
