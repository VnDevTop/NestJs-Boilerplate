import { describe, expect, it } from 'vitest';

import { UnsupportedFieldError, UnsupportedOperationError } from './errors.js';
import { SearchFieldRegistry, type SearchField } from './field-registry.js';
import { parseSearchQuery } from './parser.js';
import {
  buildDocumentExpression,
  translateToFullText,
} from './translators/full-text.js';
import { translateToFacet } from './translators/facet.js';

/**
 * The worked example, on an entity that does not exist.
 *
 * **The README makes claims about an entity with a different shape** — a uuid,
 * money as an integer, a keyword and a date — and this file is where those
 * claims are checked. A documentation file that nobody runs drifts; a spec
 * cannot.
 *
 * The entity is fictional on purpose, the same way the query layer's
 * `adding-a-route.spec.ts` adds a route that does not exist: the point is the
 * machinery, and a real table would make the test depend on a schema it is not
 * about.
 */
const orderFields: Record<string, SearchField> = {
  id: {
    type: 'uuid',
    searchable: false,
    filterable: true,
    sortable: true,
    weight: 0,
    column: 'id',
  },
  customerEmail: {
    type: 'text',
    searchable: true,
    filterable: true,
    sortable: true,
    weight: 1,
    column: 'customerEmail',
  },
  reference: {
    type: 'keyword',
    searchable: true,
    filterable: true,
    sortable: true,
    weight: 0.9,
    column: 'reference',
  },
  status: {
    type: 'keyword',
    searchable: true,
    filterable: true,
    sortable: true,
    weight: 0.5,
    column: 'status',
  },
  totalCents: {
    type: 'number',
    searchable: false,
    filterable: true,
    sortable: true,
    weight: 0.2,
    column: 'totalCents',
  },
  placedAt: {
    type: 'date',
    searchable: false,
    filterable: true,
    sortable: true,
    weight: 0.3,
    column: 'placedAt',
  },
  notes: {
    type: 'text',
    searchable: true,
    filterable: true,
    sortable: false,
    weight: 0.1,
    column: 'notes',
  },
};

const ORDERS = new SearchFieldRegistry(orderFields, {
  defaultField: 'customerEmail',
  documentColumn: 'searchVector',
});

/** The SQL a query becomes. */
function translate(query: string) {
  return translateToFullText(parseSearchQuery(query), ORDERS, {
    alias: 'order',
  });
}

describe('the document of the worked example', () => {
  it('holds the searchable text and nothing else', () => {
    const expression = buildDocumentExpression(ORDERS, { alias: 'order' });

    // The address, the reference, the status and the notes are words. The
    // amount, the date and the identifier are not, and a number in a document
    // is a number nobody searches for.
    expect(expression).toContain('"order"."customerEmail"');
    expect(expression).toContain('"order"."reference"');
    expect(expression).toContain('"order"."status"');
    expect(expression).toContain('"order"."notes"');

    expect(expression).not.toContain('"order"."totalCents"');
    expect(expression).not.toContain('"order"."placedAt"');
    expect(expression).not.toContain('"order"."id"');
  });

  it('weights the address above the reference and the status', () => {
    const expression = buildDocumentExpression(ORDERS, { alias: 'order' });

    // A is the heaviest band, then B, C and D. The address and the reference
    // are A, the status is B and the notes are D.
    expect(expression).toContain(`"order"."customerEmail", '')), 'A')`);
    expect(expression).toContain(`"order"."reference", '')), 'A')`);
    expect(expression).toContain(`"order"."status", '')), 'B')`);
    expect(expression).toContain(`"order"."notes", '')), 'D')`);
  });
});

describe('the queries of the worked example', () => {
  it('matches a bare word against the document', () => {
    const { filter } = translate('acme');

    expect(filter).toContain('"order"."searchVector" @@');
    expect(filter).toContain('plainto_tsquery');
  });

  it('compares a keyword for equality, and does not match it', () => {
    const { filter, parameters } = translate('reference:ORD-1001');

    // A keyword is one value from a closed set, so it is compared and not
    // matched — `ORD-100` finds nothing, which is what a reference is for.
    expect(filter).toContain('"order"."reference" = ');
    expect(Object.values(parameters)).toContain('ORD-1001');
  });

  it('compares a number range numerically', () => {
    const { filter, parameters } = translate('totalCents:[10000 TO 50000]');

    expect(filter).toContain('"order"."totalCents" >= ');
    expect(filter).toContain('"order"."totalCents" <= ');
    expect(Object.values(parameters)).toEqual([10000, 50000]);
  });

  it('compares a date range as timestamps', () => {
    const { filter, parameters } = translate(
      'placedAt:[2026-01-01T00:00:00Z TO 2026-12-31T00:00:00Z]',
    );

    expect(filter).toContain('"order"."placedAt" >= ');
    expect(Object.values(parameters)[0]).toBeInstanceOf(Date);
  });

  it('compares a uuid for equality', () => {
    const { filter, parameters } = translate(
      'id:8d7d34d4-8a52-4a7f-a92e-2d6d3ef9e631',
    );

    expect(filter).toContain('"order"."id" = ');
    expect(Object.values(parameters)).toContain(
      '8d7d34d4-8a52-4a7f-a92e-2d6d3ef9e631',
    );
  });

  it('matches a wildcard with a pattern, which is the unindexed path', () => {
    const { filter, parameters } = translate('notes:*ever*');

    // A leading wildcard has no index to use, and the anti-pattern list says
    // so. The mechanism is the ILIKE, and this is where it is.
    expect(filter).toContain('"order"."notes" ILIKE ');
    expect(Object.values(parameters)).toContain('%ever%');
  });
});

describe('the refusals of the worked example', () => {
  it('refuses to sort by a field that is not sortable', () => {
    // A uuid is not sortable here, and a uuid is not even searchable — the
    // refusal is about the operation, not the field.
    const sortable = ORDERS.entries().filter(([, field]) => field.sortable);

    expect(sortable.map(([name]) => name)).not.toContain('notes');
  });

  it('refuses a fuzzy term, because postgres cannot express one', () => {
    expect(() => translate('customerEmail:acme~2')).toThrow(
      UnsupportedOperationError,
    );
  });

  it('refuses a field the entity does not have', () => {
    expect(() => translate('nope:acme')).toThrow();
  });
});

describe('the facets of the worked example', () => {
  it('counts the matching rows by a field', () => {
    const { sql } = translateToFacet(
      parseSearchQuery('acme'),
      ORDERS,
      'status',
      { table: 'orders', alias: 'order' },
    );

    expect(sql).toContain('GROUP BY "order"."status"');
    // The same filter as the results, so the counts and the list cannot
    // disagree about what matched.
    expect(sql).toContain('"order"."searchVector" @@');
  });

  it('refuses to count by a field that cannot be compared', () => {
    expect(() =>
      translateToFacet(parseSearchQuery('acme'), ORDERS, 'nope', {
        table: 'orders',
        alias: 'order',
      }),
    ).toThrow();
  });
});

describe('a derived field', () => {
  const customerFields: Record<string, SearchField> = {
    firstName: {
      type: 'text',
      searchable: true,
      filterable: true,
      sortable: false,
      weight: 0.6,
      column: 'firstName',
    },
    lastName: {
      type: 'text',
      searchable: true,
      filterable: true,
      sortable: false,
      weight: 0.6,
      column: 'lastName',
    },
    // The database computes this one, so the application keeps no second copy.
    name: {
      type: 'text',
      searchable: true,
      filterable: true,
      sortable: false,
      weight: 0.6,
      column: 'fullName',
    },
  };

  const CUSTOMERS = new SearchFieldRegistry(customerFields, {
    defaultField: 'name',
    documentColumn: 'searchVector',
  });

  it('is in the document, so the field-scoped term finds it', () => {
    const expression = buildDocumentExpression(CUSTOMERS, {
      alias: 'customer',
    });

    // The derived column is one of the map's searchable fields, so the
    // document holds it and `name:john` matches.
    expect(expression).toContain('"customer"."fullName"');
  });

  it('answers the query the README says it answers', () => {
    const { filter, parameters } = translateToFullText(
      parseSearchQuery('name:john'),
      CUSTOMERS,
      { alias: 'customer' },
    );

    expect(filter).toContain('"customer"."searchVector" @@');
    expect(Object.values(parameters)).toContain('john');
  });

  it('is not sorted by, for the same reason a first name is not', () => {
    const sortable = CUSTOMERS.entries().filter(([, field]) => field.sortable);

    expect(sortable).toEqual([]);
  });
});

describe('the unsupported field is refused rather than ignored', () => {
  it('says which fields exist', () => {
    try {
      ORDERS.field('nope');

      expect.unreachable('the field should have been refused');
    } catch (error) {
      expect((error as Error).message).toContain('customerEmail');
    }
  });

  it('refuses a field that is not searchable when it is matched', () => {
    // The refusal is the point: "you may not search that field" and "no such
    // field" look the same from the outside and mean opposite things.
    expect(() => ORDERS.searchableField('totalCents')).toThrow(
      UnsupportedFieldError,
    );
  });
});
