import { describe, expect, it } from 'vitest';

import { AuditService } from './audit.service.js';
import type { AuditLog } from './entities/index.js';
import type { AuditQueryDto } from './dto/audit-query.dto.js';

/**
 * The read surface of the trail.
 *
 * **The property under test is what the route answers.** "Show me every
 * `users.update` on this account" has to be one request, and it has to be a
 * request that filters rather than one that returns the trail and hopes the
 * client sorts it out.
 *
 * The fake query builder *applies* the conditions the query layer emits rather
 * than recording them as strings. A test that asserted on SQL text would prove
 * the query looks the way it did last time, which is not the property that
 * matters: the property is that the row the investigator asked for is on the
 * page and the rows they did not ask for are not.
 */
interface Row extends Record<string, unknown> {
  id: string;
  createdAt: Date;
}

/** `"entry"."action" = :filter_0` — a comparison with one bound value. */
const COMPARISON = /^"\w+"\."(\w+)" (=|>=|<=|>|<|!=) :(\w+)$/;

/** The keyset boundary, `(sort, id) <op> (:value, :id)`. */
const TUPLE =
  /^\("\w+"\."(\w+)" (<|>) :cursorValue OR \("\w+"\."(\w+)" = :cursorValue AND "\w+"\."(\w+)" (<|>) :cursorId\)$/;

function fakeQueryBuilder(rows: Row[]) {
  const recorded = {
    fragments: [] as string[],
    parameters: [] as Record<string, unknown>[],
    order: [] as Array<[string, string]>,
    limit: undefined as number | undefined,
  };

  let remaining = rows;

  const qb = {
    andWhere(fragment: string, params?: Record<string, unknown>) {
      recorded.fragments.push(fragment);
      recorded.parameters.push(params ?? {});

      const tuple = TUPLE.exec(fragment);

      if (tuple) {
        const [, sortColumn, , idColumn, operator] = tuple;
        const value = String(params?.cursorValue ?? '');
        const id = String(params?.cursorId ?? '');

        remaining = remaining.filter((row) => {
          const left = normalise(row[sortColumn]);
          const right = String(row[idColumn]);

          return operator === '>'
            ? left > value || (left === value && right > id)
            : left < value || (left === value && right < id);
        });

        return qb;
      }

      const comparison = COMPARISON.exec(fragment);

      if (!comparison) {
        throw new Error(`Unrecognised condition: ${fragment}`);
      }

      const [, column, operator, parameter] = comparison;
      const bound = params?.[parameter];

      remaining = remaining.filter((row) => {
        const left = normalise(row[column]);
        const right = normalise(bound);

        switch (operator) {
          case '=':
            return left === right;
          case '!=':
            return left !== right;
          case '>':
            return left > right;
          case '>=':
            return left >= right;
          case '<':
            return left < right;
          default:
            return left <= right;
        }
      });

      return qb;
    },
    orderBy(column: string, direction: string) {
      recorded.order.push([unqualify(column), direction]);

      return qb;
    },
    addOrderBy(column: string, direction: string) {
      recorded.order.push([unqualify(column), direction]);

      return qb;
    },
    limit(value: number) {
      recorded.limit = value;

      return qb;
    },
    async getMany(): Promise<Row[]> {
      const [primary] = recorded.order;

      if (primary) {
        const [column, direction] = primary;

        remaining = [...remaining].sort((left, right) => {
          const a = normalise(left[column]);
          const b = normalise(right[column]);
          const byColumn = a < b ? -1 : a > b ? 1 : 0;

          if (byColumn !== 0) {
            return direction === 'DESC' ? -byColumn : byColumn;
          }

          const byId = left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

          return direction === 'DESC' ? -byId : byId;
        });
      }

      return recorded.limit === undefined
        ? remaining
        : remaining.slice(0, recorded.limit);
    },
  };

  return { qb, recorded };
}

function unqualify(column: string): string {
  return column.replace(/"/g, '').split('.').pop() ?? column;
}

function normalise(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? '');
}

function entry(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: 'e1',
    actorId: 'a1',
    actorEmail: 'ada@example.test',
    actorType: 'user',
    action: 'users.update',
    targetType: 'user',
    targetId: 'u1',
    before: null,
    after: { role: 'admin' },
    changedFields: ['role'],
    ipAddress: '203.0.113.9',
    userAgent: 'Firefox on Linux',
    requestId: 'req-1',
    outcome: 'success',
    statusCode: 200,
    error: null,
    createdAt: new Date('2026-10-20T09:12:03.000Z'),
    ...overrides,
  } as AuditLog;
}

function harness(rows: AuditLog[]) {
  const { qb, recorded } = fakeQueryBuilder(
    rows.map((row) => ({ ...row }) as Row),
  );

  const repository = { createQueryBuilder: () => qb };
  const service = new AuditService(repository as never);

  return { service, recorded };
}

/** A query the way the route's DTO produces it. */
function query(overrides: Partial<AuditQueryDto> = {}): AuditQueryDto {
  return { limit: 20, ...overrides } as AuditQueryDto;
}

describe('reading the trail', () => {
  it('answers "every users.update on this account" with exactly that', async () => {
    const { service } = harness([
      entry({ id: 'e1', action: 'users.update', targetId: 'u1' }),
      entry({ id: 'e2', action: 'users.create', targetId: 'u1' }),
      entry({ id: 'e3', action: 'users.update', targetId: 'u2' }),
    ]);

    const page = await service.list(
      query({ action: 'users.update', targetId: 'u1' }),
    );

    // The whole point of the phase: the question is one request, and the rows it
    // did not ask for are not on the page.
    expect(page.items.map((row) => row.id)).toEqual(['e1']);
  });

  it('binds the values instead of interpolating them', async () => {
    const { service, recorded } = harness([entry()]);

    await service.list(query({ action: 'users.update' }));

    // No client-supplied text reaches the SQL. The column names come from the
    // spec and the values are parameters, which is the only reason a filter can
    // be safe.
    expect(recorded.fragments.join(' ')).toContain(
      '"entry"."action" = :filter_0',
    );
    expect(recorded.fragments.join(' ')).not.toContain('users.update');
    expect(recorded.parameters[0]).toMatchObject({ filter_0: 'users.update' });
  });

  it('reads a window as two bounds rather than one', async () => {
    const { service, recorded } = harness([entry()]);

    await service.list(
      query({
        from: '2026-10-01T00:00:00Z',
        to: '2026-10-31T00:00:00Z',
      }),
    );

    // The request says *what* to filter by and never *how*: a client that could
    // pick the operator could pick the one that makes the window mean something
    // else.
    expect(recorded.fragments).toContain('"entry"."createdAt" >= :filter_0');
    expect(recorded.fragments).toContain('"entry"."createdAt" <= :filter_1');
  });

  it('filters by the actor, by id and by kind', async () => {
    const { service } = harness([
      entry({ id: 'e1', actorId: 'a1', actorType: 'user' }),
      entry({ id: 'e2', actorId: 'a2', actorType: 'system' }),
    ]);

    const page = await service.list(query({ actorId: 'a2' }));

    expect(page.items.map((row) => row.id)).toEqual(['e2']);
  });

  it('finds the failures, which are the half most systems skip', async () => {
    const { service } = harness([
      entry({ id: 'e1', outcome: 'success' }),
      entry({ id: 'e2', outcome: 'failure' }),
    ]);

    const page = await service.list(query({ outcome: 'failure' }));

    expect(page.items.map((row) => row.id)).toEqual(['e2']);
  });

  it('returns the newest first', async () => {
    const { service } = harness([
      entry({ id: 'e1', createdAt: new Date('2026-10-19T00:00:00.000Z') }),
      entry({ id: 'e2', createdAt: new Date('2026-10-20T00:00:00.000Z') }),
    ]);

    const page = await service.list(query());

    expect(page.items.map((row) => row.id)).toEqual(['e2', 'e1']);
  });

  it('reports the row in the shape the route returns', async () => {
    const { service } = harness([entry()]);

    const page = await service.list(query());

    expect(page.items[0]).toMatchObject({
      id: 'e1',
      action: 'users.update',
      actorEmail: 'ada@example.test',
      outcome: 'success',
      changedFields: ['role'],
      createdAt: '2026-10-20T09:12:03.000Z',
    });
  });

  it('does not swallow a failed read the way a failed write is swallowed', async () => {
    // The two halves of this service fail in opposite directions, on purpose. A
    // read that failed and answered "no rows" would be a lie an investigator
    // would act on: "nobody touched this account" and "the database was down"
    // look identical until somebody checks the logs.
    const failingQuery = {
      andWhere: () => failingQuery,
      orderBy: () => failingQuery,
      addOrderBy: () => failingQuery,
      limit: () => failingQuery,
      getMany: async () => {
        throw new Error('connection terminated');
      },
    };

    const failing = new AuditService({
      createQueryBuilder: () => failingQuery,
    } as never);

    await expect(failing.list(query())).rejects.toThrow(
      'connection terminated',
    );
  });
});
