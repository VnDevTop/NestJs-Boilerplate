import { describe, expect, it } from 'vitest';

import {
  buildCriteria,
  defineQuerySpec,
  readPage,
  type FilterKeys,
} from './index.js';

/**
 * The phase's done-when criterion, stated as a test.
 *
 * **"Done when adding a list route needs no new pagination code."** A route is
 * three things: a DTO that says what the request may contain, a spec that says
 * what each field means, and one call that reads a page. This file adds a route
 * that does not exist — a fictional `widgets` table — and shows that the third
 * thing is a single line.
 *
 * **The route is fictional on purpose.** A test that adds a route to a real
 * entity proves the route works; this proves the *shape* is enough, which is the
 * claim being made.
 */
describe('adding a list route', () => {
  /**
   * The three things a new route needs.
   *
   * **A DTO, a spec, and a call.** Nothing else. No query builder, no filter
   * loop, no cursor handling, no `hasMore` arithmetic.
   */
  interface WidgetQuery {
    limit: number;
    cursor?: string;
    sort?: string;
    order?: string;
    name?: string;
    active?: boolean;
  }

  const WIDGET_SPEC = defineQuerySpec<WidgetQuery>({
    filters: {
      name: { column: 'name', operator: 'ilike' },
      active: { column: 'active', operator: 'eq' },
    },
    sort: {
      createdAt: 'createdAt',
      name: 'name',
    },
    defaultSort: 'createdAt',
  });

  it('needs a DTO, a spec and one call', () => {
    // The whole of a new list route. The service method is these two lines.
    const criteria = buildCriteria(
      { limit: 20, name: 'gear', active: true } as WidgetQuery,
      WIDGET_SPEC,
    );

    expect(criteria.filters).toEqual([
      { column: 'name', operator: 'ilike', value: 'gear' },
      { column: 'active', operator: 'eq', value: true },
    ]);
    expect(criteria.sort).toEqual({ column: 'createdAt', direction: 'DESC' });
    expect(criteria.limit).toBe(20);
  });

  it('reads a page through the same call every other route uses', async () => {
    const statements: string[] = [];

    const query = {
      andWhere: (fragment: string) => {
        statements.push(fragment);

        return query;
      },
      orderBy: () => query,
      addOrderBy: () => query,
      limit: () => query,
      getMany: async () => [],
    };

    const page = await readPage({
      query: query as never,
      criteria: buildCriteria(
        { limit: 5, name: 'gear' } as WidgetQuery,
        WIDGET_SPEC,
      ),
      alias: 'widget',
    });

    // The filters went on, the sort went on, and the page came back with its
    // meta. No route-specific paging code anywhere in it.
    expect(statements).toEqual([`"widget"."name" ILIKE :filter_0 ESCAPE '\\'`]);
    expect(page.meta).toEqual({ limit: 5, hasMore: false, nextCursor: null });
  });

  it('refuses a filter named after a paging key, at compile time', () => {
    // The type is the assertion. `FilterKeys` excludes `limit`, `cursor`, `sort`
    // and `order`, so a spec that declared a filter named `sort` would not
    // compile — writing that line here is a compile error, which is the point.
    //
    // The runtime half proves the same fact in a way a reader can check: the
    // reserved names are not among the filterable ones, and the field that is, is.
    type Filterable = FilterKeys<{
      limit: number;
      cursor?: string;
      sort?: string;
      order?: string;
      role?: string;
    }>;

    // Assigning a name that is not filterable is a compile error, so this array
    // holds only the ones that are.
    const filterable: Filterable[] = ['role'];

    expect(filterable).toEqual(['role']);

    // The reserved names are not filterable, and this is the type saying so.
    // A name that is not a `Filterable` is `never` here, so the check below
    // would not compile if `sort` were filterable.
    type IsFilterable<TName extends string> = TName extends Filterable
      ? true
      : false;

    const sortIsFilterable: IsFilterable<'sort'> = false;
    const roleIsFilterable: IsFilterable<'role'> = true;

    expect(sortIsFilterable).toBe(false);
    expect(roleIsFilterable).toBe(true);
  });

  it('produces the same statement whatever order the client asked in', () => {
    // Two requests naming the same fields produce the same SQL, which is what
    // makes the query cacheable and the statement comparable between requests.
    const first = buildCriteria(
      { name: 'gear', active: true } as WidgetQuery,
      WIDGET_SPEC,
    );
    const second = buildCriteria(
      { active: true, name: 'gear' } as WidgetQuery,
      WIDGET_SPEC,
    );

    expect(first.filters).toEqual(second.filters);
  });
});
