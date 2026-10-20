import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor } from '../pagination/index.js';
import { buildCriteria } from './build-criteria.js';
import { readPage } from './read-page.js';
import type { QuerySpec } from './query-spec.js';

interface Row extends Record<string, unknown> {
  id: string;
  createdAt: Date;
  email?: string;
}

const SPEC = {
  filters: {},
  sort: { createdAt: 'createdAt' },
  defaultSort: 'createdAt',
} as const satisfies QuerySpec;

/**
 * A stand-in for a TypeORM query builder that *executes* the boundary the query
 * layer emits.
 *
 * **Why not assert on SQL strings.** That proves the query looks the way it did
 * last time, which is not the property Phase 23 is done when. The property is
 * behavioural: a row inserted between two page requests must not appear on both
 * pages or on neither. Only something that actually applies the condition can
 * demonstrate it.
 *
 * The condition this recognises is the one the query layer emits — a tuple
 * comparison `(sort, id) <op> (:value, :id)` — and the pattern is asserted
 * separately in "builds the boundary as a tuple". If the layer ever changes
 * shape, this simulator fails to match and the tests fail loudly rather than
 * quietly passing on an unfiltered query.
 */
const TUPLE_FRAGMENT =
  /^\("\w+"\."\w+" (<|>) :cursorValue OR \("\w+"\."\w+" = :cursorValue AND "\w+"\."\w+" (<|>) :cursorId\)\)$/;

function fakeQueryBuilder(rows: Row[]): {
  qb: never;
  recorded: {
    fragments: string[];
    order: Array<[string, string]>;
    limit?: number;
  };
} {
  const recorded = {
    fragments: [] as string[],
    order: [] as Array<[string, string]>,
    limit: undefined as number | undefined,
  };

  interface FakeQueryBuilder {
    andWhere(
      fragment: string,
      params?: Record<string, unknown>,
    ): FakeQueryBuilder;
    orderBy(column: string, direction: string): FakeQueryBuilder;
    addOrderBy(column: string, direction: string): FakeQueryBuilder;
    limit(value: number): FakeQueryBuilder;
    getMany(): Promise<Row[]>;
  }

  const qb: FakeQueryBuilder = {
    andWhere(
      fragment: string,
      params?: Record<string, unknown>,
    ): FakeQueryBuilder {
      recorded.fragments.push(fragment);

      const match = TUPLE_FRAGMENT.exec(fragment);

      if (!match) {
        throw new Error(`Unrecognised condition: ${fragment}`);
      }

      const [operator, , idOperator] = match;
      const sortColumn = fragment.match(/"\w+"\."(\w+)"/)?.[1] ?? '';
      const idColumn = fragment.match(/AND "\w+"\."(\w+)"/)?.[1] ?? '';

      // `Date` values come back as ISO strings when the boundary is bound, so the
      // comparison normalises both sides the way postgres would.
      const boundaryValue = normalise(params?.cursorValue);
      const boundaryId = String(params?.cursorId);

      rows = rows.filter((row) => {
        const left = normalise(row[sortColumn]);
        const right = String(row[idColumn]);

        return operator === idOperator && operator === '>'
          ? left > boundaryValue ||
              (left === boundaryValue && right > boundaryId)
          : left < boundaryValue ||
              (left === boundaryValue && right < boundaryId);
      });

      return qb;
    },
    orderBy(column: string, direction: string): FakeQueryBuilder {
      // Unqualified for the comparison, the way postgres reads a quoted identifier.
      recorded.order.push([unqualify(column), direction]);

      return qb;
    },
    addOrderBy(column: string, direction: string): FakeQueryBuilder {
      recorded.order.push([unqualify(column), direction]);

      return qb;
    },
    limit(value: number): FakeQueryBuilder {
      recorded.limit = value;

      return qb;
    },
    async getMany(): Promise<Row[]> {
      const [primary] = recorded.order;

      if (primary) {
        const [column, direction] = primary;

        rows = [...rows].sort((left, right) => {
          const a = normalise(left[column]);
          const b = normalise(right[column]);
          const byColumn = a < b ? -1 : a > b ? 1 : 0;

          if (byColumn !== 0) {
            return direction === 'DESC' ? -byColumn : byColumn;
          }

          // The tie-break, which is the whole reason a keyset page is total.
          const byId = left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

          return direction === 'DESC' ? -byId : byId;
        });
      }

      return recorded.limit === undefined
        ? rows
        : rows.slice(0, recorded.limit);
    },
  };

  return { qb: qb as never, recorded };
}

/** `"row"."createdAt"` becomes `createdAt`, which is how the row is keyed. */
function unqualify(column: string): string {
  return column.replace(/"/g, '').split('.').pop() ?? column;
}

function normalise(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? '');
}

function rows(count: number, prefix = 'u'): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${String(index).padStart(3, '0')}`,
    // Deliberately identical timestamps for some rows: `createdAt` is not unique,
    // and the tie-break is what keeps a page from re-reading or skipping them.
    createdAt: new Date(
      Date.parse('2026-10-03T03:17:00.000Z') + Math.floor(index / 3) * 1000,
    ),
  }));
}

describe('reading a page', () => {
  it('reads one row past the limit rather than counting the table', async () => {
    const { qb, recorded } = fakeQueryBuilder(rows(5));

    await readPage({
      query: qb,
      criteria: buildCriteria({ limit: 2 }, SPEC),
      alias: 'row',
    });

    // The extra row *is* the `hasMore` answer. A count would be the expensive
    // query this replaces.
    expect(recorded.limit).toBe(3);
  });

  it('orders by the sort column and then by id, in one direction', async () => {
    const { qb, recorded } = fakeQueryBuilder(rows(5));

    await readPage({
      query: qb,
      criteria: buildCriteria({ limit: 2 }, SPEC),
      alias: 'row',
    });

    expect(recorded.order).toEqual([
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ]);
  });

  it('builds the boundary as a tuple, with both values bound', async () => {
    const { qb, recorded } = fakeQueryBuilder(rows(5));

    await readPage({
      query: qb,
      criteria: buildCriteria(
        {
          limit: 2,
          cursor: encodeCursor({
            value: '2026-10-03T03:17:00.000Z',
            id: 'u000',
          }),
        },
        SPEC,
      ),
      alias: 'row',
    });

    // No client-supplied text reaches the SQL. The sort column is the one the
    // spec resolved; the two boundary values are parameters, which is the only
    // reason a cursor can be treated as opaque.
    expect(recorded.fragments).toHaveLength(1);
    expect(recorded.fragments[0]).toContain('"row"."createdAt" < :cursorValue');
    expect(recorded.fragments[0]).toContain('"row"."id" < :cursorId');
  });

  it('flips the operator for ascending order', async () => {
    const { qb, recorded } = fakeQueryBuilder(rows(5));

    await readPage({
      query: qb,
      criteria: buildCriteria(
        {
          limit: 2,
          order: 'asc',
          cursor: encodeCursor({
            value: '2026-10-03T03:17:01.000Z',
            id: 'u000',
          }),
        },
        SPEC,
      ),
      alias: 'row',
    });

    expect(recorded.fragments[0]).toContain('>');
    expect(recorded.fragments[0]).not.toContain('<');
  });

  it('emits no boundary on the first page', async () => {
    const { qb, recorded } = fakeQueryBuilder(rows(5));

    await readPage({
      query: qb,
      criteria: buildCriteria({ limit: 2 }, SPEC),
      alias: 'row',
    });

    expect(recorded.fragments).toEqual([]);
  });

  it('reports another page and hands back a cursor for it', async () => {
    const { qb } = fakeQueryBuilder(rows(5));

    const page = await readPage({
      query: qb,
      criteria: buildCriteria({ limit: 2 }, SPEC),
      alias: 'row',
    });

    expect(page.items).toHaveLength(2);
    expect(page.meta.hasMore).toBe(true);
    expect(page.meta.nextCursor).not.toBeNull();
    expect(page.meta.limit).toBe(2);
  });

  it('ends the walk with hasMore false and no cursor', async () => {
    const { qb } = fakeQueryBuilder(rows(4));

    const page = await readPage({
      query: qb,
      criteria: buildCriteria({ limit: 10 }, SPEC),
      alias: 'row',
    });

    expect(page.items).toHaveLength(4);
    expect(page.meta.hasMore).toBe(false);
    // Null rather than a cursor that would return nothing: a client should stop,
    // not ask one more time and be told "no rows" for a page that never existed.
    expect(page.meta.nextCursor).toBeNull();
  });

  it('walks the whole set exactly once', async () => {
    const all = rows(11);
    const seen: string[] = [];
    let cursor: string | undefined;

    // Seven pages of two, which is more than the set holds — the walk must stop on
    // its own rather than needing the client to notice the end.
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const { qb } = fakeQueryBuilder(all);
      const page = await readPage({
        query: qb,
        criteria: buildCriteria({ limit: 2, cursor }, SPEC),
        alias: 'row',
      });

      seen.push(...page.items.map((row) => row.id));

      if (!page.meta.hasMore) {
        break;
      }

      cursor = page.meta.nextCursor ?? undefined;
    }

    expect(seen).toHaveLength(all.length);
    expect(new Set(seen).size).toBe(all.length);
  });

  /**
   * The acceptance criterion, stated as a test.
   *
   * A row is inserted *after* the first page was read. With `OFFSET` paging the
   * inserted row takes a slot and every row after the boundary shifts down one, so
   * it appears on page two having already been counted against page one's total —
   * or, in the opposite direction, is skipped entirely. A cursor names where it
   * stopped, so the insert ahead of the reader cannot move the boundary.
   */
  it('loses no row and repeats none when a row is inserted between two pages', async () => {
    const original = rows(9);
    const { qb } = fakeQueryBuilder(original);

    const first = await readPage({
      query: qb,
      criteria: buildCriteria({ limit: 4 }, SPEC),
      alias: 'row',
    });

    // A row created after the read, with the newest timestamp — the case that
    // shifts an offset walk by one.
    const inserted: Row = {
      id: 'u999',
      createdAt: new Date('2026-10-03T04:00:00.000Z'),
    };

    const seen = first.items.map((row) => row.id);

    let cursor = first.meta.nextCursor ?? undefined;
    let more = first.meta.hasMore;

    while (more) {
      const page = fakeQueryBuilder([...original, inserted]);

      const result = await readPage({
        query: page.qb,
        criteria: buildCriteria({ limit: 4, cursor }, SPEC),
        alias: 'row',
      });

      seen.push(...result.items.map((row) => row.id));
      more = result.meta.hasMore;
      cursor = result.meta.nextCursor ?? undefined;
    }

    // Every original row exactly once, and the new row — which sorts ahead of the
    // boundary — not at all, because it was created after the reader passed it.
    expect(seen).toHaveLength(original.length);
    expect(new Set(seen).size).toBe(original.length);
    expect(seen).not.toContain('u999');
  });

  it('never drops or repeats a row when two pages share a timestamp', async () => {
    const all = rows(30);
    const seen: string[] = [];
    let cursor: string | undefined;
    let more = true;

    while (more) {
      const { qb } = fakeQueryBuilder(all);
      const page = await readPage({
        query: qb,
        criteria: buildCriteria({ limit: 4, cursor }, SPEC),
        alias: 'row',
      });

      seen.push(...page.items.map((row) => row.id));
      more = page.meta.hasMore;
      cursor = page.meta.nextCursor ?? undefined;
    }

    // Every third row shares its timestamp with two others, so the boundary lands
    // inside a group on most pages. Only the id tie-break makes that safe.
    expect(seen).toHaveLength(all.length);
    expect(new Set(seen).size).toBe(all.length);
  });

  it('refuses a malformed cursor rather than silently returning page one', () => {
    // The refusal happens when the criteria are built, before any query runs.
    expect(() => buildCriteria({ limit: 2, cursor: 'rubbish' }, SPEC)).toThrow(
      BadRequestException,
    );
  });

  it('clamps an oversized or unparseable page size', async () => {
    const tooBig = fakeQueryBuilder(rows(500));

    await readPage({
      query: tooBig.qb,
      criteria: buildCriteria({ limit: 10_000 }, SPEC),
      alias: 'row',
    });
    expect(tooBig.recorded.limit).toBe(101);

    const nonsense = fakeQueryBuilder(rows(5));

    await readPage({
      query: nonsense.qb,
      criteria: buildCriteria({ limit: Number.NaN }, SPEC),
      alias: 'row',
    });
    expect(nonsense.recorded.limit).toBe(21);
  });

  it('honours a custom tie-break column', async () => {
    const { qb, recorded } = fakeQueryBuilder(rows(5));

    await readPage({
      query: qb,
      criteria: buildCriteria({ limit: 2 }, SPEC),
      alias: 'row',
      idColumn: 'uuid',
    });

    expect(recorded.order[1]).toEqual(['uuid', 'DESC']);
  });

  it('encodes a timestamp boundary to the microsecond', async () => {
    const source = rows(5);
    const { qb } = fakeQueryBuilder(source);

    const page = await readPage({
      query: qb,
      criteria: buildCriteria({ limit: 1 }, SPEC),
      alias: 'row',
    });
    const decoded = decodeCursor(page.meta.nextCursor ?? undefined);

    // A cursor that rounded to the millisecond would re-read the boundary row on
    // the next page, because the comparison would start above it.
    const first = page.items[0];

    expect(decoded).toEqual({
      value: first.createdAt.toISOString(),
      id: first.id,
    });
  });
});
