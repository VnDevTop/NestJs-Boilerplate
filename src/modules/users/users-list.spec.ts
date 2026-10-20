import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { PaginatedResultDto } from '../../common/pagination/index.js';
import { Role } from '../../common/enums/index.js';
import { UsersService } from './users.service.js';
import { ListUsersQueryDto } from './dto/index.js';
import { User } from './entities/index.js';

/**
 * `GET /users` is the first route on the shared pagination layer, so these tests
 * are about the layer as much as the route: which filters become bound values,
 * and what happens when a client names a column the route does not offer.
 */

interface Recorded {
  fragments: Array<{ sql: string; params?: Record<string, unknown> }>;
  limit?: number;
}

/**
 * A repository double that records conditions instead of running them.
 *
 * Recording rather than executing is deliberate here: the point is what reaches
 * SQL, and the execution semantics of the keyset boundary are already proven in
 * `cursor-pagination.spec.ts` against rows that are really filtered.
 */
function harness(rows: User[] = []) {
  const recorded: Recorded = { fragments: [] };

  const queryBuilder = {
    andWhere(sql: string, params?: Record<string, unknown>) {
      recorded.fragments.push({ sql, params });

      return queryBuilder;
    },
    orderBy() {
      return queryBuilder;
    },
    addOrderBy() {
      return queryBuilder;
    },
    limit(value: number) {
      recorded.limit = value;

      return queryBuilder;
    },
    async getMany() {
      return rows;
    },
  };

  const repository = {
    createQueryBuilder: vi.fn(() => queryBuilder),
  };

  const service = new UsersService(
    repository as never,
    { wrap: vi.fn(), deleteKeys: vi.fn() } as never,
    { getOrThrow: () => ({ authUserTtl: 60 }) } as never,
    { notify: vi.fn() } as never,
    { forget: vi.fn() } as never,
  );

  return { service, recorded, repository };
}

function query(overrides: Partial<ListUsersQueryDto> = {}): ListUsersQueryDto {
  return Object.assign(new ListUsersQueryDto(), overrides);
}

const ROW = {
  id: 'u1',
  email: 'a@x.com',
  role: Role.User,
  isActive: true,
  isManager: false,
  sessionsVersion: 0,
  isEmailVerified: true,
  lastLoginAt: null,
  createdAt: new Date('2026-10-03T03:17:00.000Z'),
  updatedAt: new Date('2026-10-03T03:17:00.000Z'),
  deletedAt: null,
} as unknown as User;

describe('GET /users', () => {
  it('returns a page and its meta, not a bare array', async () => {
    const { service } = harness([ROW]);

    const result = await service.findAll(query({ limit: 1 }));

    expect(result).toBeInstanceOf(PaginatedResultDto);
    expect(result.items).toHaveLength(1);
    expect(result.meta).toEqual({
      limit: 1,
      hasMore: false,
      nextCursor: null,
    });
  });

  it('asks for one row past the page so hasMore is known', async () => {
    const { service, recorded } = harness([ROW]);

    await service.findAll(query({ limit: 5 }));

    expect(recorded.limit).toBe(6);
  });

  it('clamps an oversized limit before it reaches the database', async () => {
    const { service, recorded } = harness([]);

    await service.findAll(query({ limit: 5_000 }));

    expect(recorded.limit).toBe(101);
  });

  it('refuses a sort field the route does not offer', async () => {
    const { service } = harness([]);

    // `password` is the field a caller would try, and it is on the table. Sorting
    // by a client-supplied column name is injection with a different name, so the
    // request never reaches the query.
    await expect(
      service.findAll(query({ sort: 'password' })),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(service.findAll(query({ sort: 'password' }))).rejects.toThrow(
      /createdAt, email, role, isActive/,
    );
  });

  it('accepts every field in its allow-list', async () => {
    const { service } = harness([]);

    for (const sort of ['createdAt', 'email', 'role', 'isActive']) {
      await expect(service.findAll(query({ sort }))).resolves.toBeInstanceOf(
        PaginatedResultDto,
      );
    }
  });

  it('binds the role filter rather than interpolating it', async () => {
    const { service, recorded } = harness([]);

    await service.findAll(query({ role: Role.Admin }));

    // The column is quoted and qualified with the alias, and the value is a
    // parameter. The SQL text carries no part of the value.
    expect(recorded.fragments).toEqual([
      {
        sql: '"user"."role" = :filter_0',
        params: { filter_0: Role.Admin },
      },
    ]);
  });

  it('binds the boolean filters, including isActive=false', async () => {
    const { service, recorded } = harness([]);

    // The unfiltered list is the active accounts, so a client asking for
    // *inactive* ones has to be answered by a filter that is actually sent —
    // omitting it would silently answer the opposite question.
    await service.findAll(query({ isActive: false }));

    expect(recorded.fragments).toEqual([
      {
        sql: '"user"."isActive" = :filter_0',
        params: { filter_0: false },
      },
    ]);
  });

  it('sends no filter at all when none was asked for', async () => {
    const { service, recorded } = harness([]);

    await service.findAll(query());

    expect(recorded.fragments).toEqual([]);
  });

  it('escapes the wildcards in an email search', async () => {
    const { service, recorded } = harness([]);

    // A search box that treats `%` and `_` as wildcards returns rows nobody asked
    // for, and `_` in an address is not rare enough to be theoretical.
    await service.findAll(query({ email: 'a_%b' }));

    const [condition] = recorded.fragments;

    expect(condition?.sql).toBe(`"user"."email" ILIKE :filter_0 ESCAPE '\\'`);
    expect(condition?.params?.filter_0).toBe('%a\\_\\%b%');
  });

  it('ignores an email search that is only whitespace', async () => {
    const { service, recorded } = harness([]);

    await service.findAll(query({ email: '   ' }));

    // Otherwise the term becomes `%%`, which matches every row in the table —
    // a full scan dressed up as a filter.
    expect(recorded.fragments).toEqual([]);
  });

  it('never returns the password hash, paged or not', async () => {
    const { service } = harness([ROW]);

    const result = await service.findAll(query());

    expect(result.items[0]).not.toHaveProperty('password');
  });
});
