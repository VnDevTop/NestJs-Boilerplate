import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authUserKey } from '../../core/cache/index.js';
import type { JwtPayload } from '../../common/interfaces/index.js';
import { UsersService } from '../users/users.service.js';
import type { User } from '../users/entities/index.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';

/**
 * The property the whole phase is judged on: **a revoked or changed caller is
 * refused on the very next request, without waiting an entry out.**
 *
 * `users.service.spec.ts` covers the cache in isolation and this one covers the
 * cache actually being consulted, so it wires the real `UsersService` and the real
 * `JwtStrategy` together over a store that behaves like redis — a `Map` behind
 * `get`/`set`/`delete`, so a `delete` really removes the entry rather than being a
 * recorded call.
 *
 * A mock at either end would pass with the invalidation removed, which is the
 * regression this exists to catch.
 */

const SECRET = 'a'.repeat(32);

type Row = {
  id: string;
  email: string;
  password: string;
  role: string;
  isActive: boolean;
  isManager: boolean;
  sessionsVersion: number;
};

/** Mutable, so a test can change the row the way an operator would. */
function harness(seed: Partial<Row> = {}) {
  const row: Row = {
    id: 'u1',
    email: 'a@x.com',
    password: '$2b$10$notarealhash',
    role: 'user',
    isActive: true,
    isManager: false,
    sessionsVersion: 0,
    ...seed,
  };

  const store = new Map<string, unknown>();
  const queries: unknown[][] = [];

  // TypeORM excludes a soft-deleted row from later reads because the entity
  // declares a delete date. Modelling that is the point: the cache is dropped
  // precisely so the next read asks the database again.
  let deletedAt: Date | null = null;

  const cache = {
    wrap: async <T>(key: string, loader: () => Promise<T>): Promise<T> => {
      if (store.has(key)) {
        return store.get(key) as T;
      }

      const value = await loader();
      store.set(key, value);

      return value;
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };

  const repository = {
    findOne: vi.fn(async (options?: { select?: Record<string, boolean> }) => {
      if (deletedAt !== null) {
        return null;
      }

      // `findById` asks for the whole row and `findAuthClaims` asks for named
      // columns, so both shapes have to work.
      if (!options?.select) {
        return row;
      }

      queries.push(Object.keys(options.select));

      // The column list decides whether the hash is fetched, and a fake that
      // ignored it would let a regression put a password hash in redis through
      // every test below.
      return Object.keys(options.select).reduce<Record<string, unknown>>(
        (out, column) => {
          out[column] = row[column as keyof Row];
          return out;
        },
        {},
      ) as never;
    }),
    save: vi.fn(async (value: Partial<Row>) => {
      Object.assign(row, value);
      return row;
    }),
    merge: vi.fn((current: Row, dto: Partial<Row>) => ({ ...current, ...dto })),
    softDelete: vi.fn(async () => {
      deletedAt = new Date();
    }),
  };

  const usersService = new UsersService(
    repository as never,
    cache as never,
    { getOrThrow: () => ({ authUserTtl: 60, authRoleTtl: 600 }) } as never,
  );

  const strategy = new JwtStrategy(
    { get: () => SECRET } as unknown as ConfigService,
    usersService,
    { forRole: vi.fn().mockResolvedValue(['user:read']) } as never,
  );

  return {
    strategy,
    usersService,
    row,
    store,
    queries,
    isDeleted: () => deletedAt !== null,
  };
}

const token = (overrides: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: 'u1',
  email: 'a@x.com',
  ...overrides,
});

describe('an authenticated request served from cache', () => {
  it('is accepted, and the second one costs no query', async () => {
    const h = harness();

    await expect(h.strategy.validate(token({ sv: 0 }))).resolves.toMatchObject({
      id: 'u1',
    });
    await expect(h.strategy.validate(token({ sv: 0 }))).resolves.toMatchObject({
      id: 'u1',
    });

    expect(h.queries).toHaveLength(1);
  });

  it('never fetched the password hash', async () => {
    const h = harness();

    await h.strategy.validate(token({ sv: 0 }));

    expect(h.queries[0]).not.toContain('password');
  });

  it('keys the entry on the user, not on the token', async () => {
    // Two tokens for one user share an entry, which is what makes a role change
    // observable to a session signed before it.
    const h = harness();

    await h.strategy.validate(token({ sv: 0 }));
    await h.strategy.validate(token({ sv: 0, email: 'stale@x.com' }));

    expect([...h.store.keys()]).toEqual([authUserKey('u1')]);
  });
});

describe('a change made after the entry was written', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  it('deactivating a user is refused on the next request', async () => {
    await h.strategy.validate(token({ sv: 0 }));

    h.row.isActive = false;
    await h.usersService.invalidateAuthCache('u1');

    await expect(h.strategy.validate(token({ sv: 0 }))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('a role change is seen by a session signed before it', async () => {
    // Through `update`, which is the path an admin screen takes, rather than a
    // direct invalidation, so the wiring between the two is covered. A demotion
    // that never reaches the cache is an escalation lasting the rest of the TTL.
    h = harness({ role: 'admin' });
    expect((await h.strategy.validate(token({ sv: 0 }))).role).toBe('admin');

    await h.usersService.update('u1', { role: 'user' } as never);

    expect((await h.strategy.validate(token({ sv: 0 }))).role).toBe('user');
  });

  it('a soft delete is refused on the next request', async () => {
    await h.strategy.validate(token({ sv: 0 }));

    await h.usersService.softDelete('u1');

    await expect(h.strategy.validate(token({ sv: 0 }))).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

describe('logout everywhere', () => {
  it('kills an access token minted before it, on the next request', async () => {
    // The full loop: the token was minted at version 0, the account is bumped,
    // and the token that the cache would happily keep authorising is refused
    // because the cached claims moved with it.
    const h = harness();

    await expect(h.strategy.validate(token({ sv: 0 }))).resolves.toBeTruthy();

    h.row.sessionsVersion = 1;

    await h.usersService.runThenInvalidateAuthCache('u1', async () => {
      h.row.sessionsVersion += 1;
    });

    await expect(h.strategy.validate(token({ sv: 0 }))).rejects.toThrow(
      'Invalid access token',
    );
  });

  it('reloads the version rather than serving the one it had', async () => {
    // The failure this guards is a cache entry that outlives the revocation, so
    // the assertion is on the query count as much as the outcome.
    const h = harness();

    await h.strategy.validate(token({ sv: 0 }));
    h.row.sessionsVersion = 1;
    await h.usersService.invalidateAuthCache('u1');
    await expect(h.strategy.validate(token({ sv: 0 }))).rejects.toThrow();

    expect(h.queries).toHaveLength(2);
  });

  it('does not survive a bump that ran inside the transaction', async () => {
    // Reproduces the race the ordering exists to prevent: an entry refilled from
    // the pre-commit row would carry the version being revoked.
    const h = harness();

    await h.strategy.validate(token({ sv: 0 }));

    await h.usersService.runThenInvalidateAuthCache('u1', async () => {
      // Standing in for a request landing mid-transaction: it reads the old row
      // and caches it, and the delete has not happened yet.
      await h.strategy.validate(token({ sv: 0 }));
      h.row.sessionsVersion = 1;
    });

    await expect(h.strategy.validate(token({ sv: 0 }))).rejects.toThrow(
      'Invalid access token',
    );
  });
});
