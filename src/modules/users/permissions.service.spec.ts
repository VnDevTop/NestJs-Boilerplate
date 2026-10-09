import type { Repository } from 'typeorm';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Role } from '../../common/enums/index.js';
import { RolePermission } from './entities/index.js';
import { PermissionsService } from './permissions.service.js';

interface Harness {
  service: PermissionsService;
  find: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  store: Map<string, unknown>;
  deletedKeys: string[];
  cacheDelete: ReturnType<typeof vi.fn>;
}

/**
 * A store behind the cache, rather than a recorded call. A `delete` that only
 * recorded would pass with the entry still in place, which is the regression the
 * invalidation tests exist to catch.
 */
function fakeCache() {
  const store = new Map<string, unknown>();
  const deletedKeys: string[] = [];

  return {
    store,
    deletedKeys,
    wrap: async <T>(key: string, loader: () => Promise<T>): Promise<T> => {
      if (store.has(key)) {
        return store.get(key) as T;
      }

      const value = await loader();
      store.set(key, value);

      return value;
    },
    delete: vi.fn(async (key: string) => {
      deletedKeys.push(key);
      store.delete(key);
    }),
  };
}

const grant = (role: string, name: string): Partial<RolePermission> =>
  ({ role, permission: { name } }) as Partial<RolePermission>;

function harness(): Harness {
  const find = vi.fn().mockResolvedValue([]);
  const remove = vi.fn().mockResolvedValue({ affected: 0 });
  const insert = vi.fn().mockResolvedValue({ identifiers: [] });
  const findPermissions = vi.fn().mockResolvedValue([]);
  const cache = fakeCache();

  const manager = {
    delete: remove,
    insert,
    transaction: vi.fn(async (fn: (m: unknown) => Promise<void>) =>
      fn(manager),
    ),
    getRepository: () => ({ find: findPermissions }),
  };

  const grants = {
    find,
    manager,
  } as unknown as Repository<RolePermission>;

  return {
    service: new PermissionsService(
      grants,
      cache as never,
      { getOrThrow: () => ({ authRoleTtl: 600 }) } as never,
    ),
    find,
    delete: remove,
    insert,
    transaction: manager.transaction,
    store: cache.store,
    deletedKeys: cache.deletedKeys,
    cacheDelete: cache.delete,
  };
}

describe('PermissionsService', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  describe('forRole', () => {
    it('returns the names the role holds', async () => {
      h.find.mockResolvedValue([
        grant('admin', 'user:read'),
        grant('admin', 'user:write'),
      ]);

      expect(await h.service.forRole('admin')).toEqual([
        'user:read',
        'user:write',
      ]);
    });

    it('returns an empty set for a role with no grants, rather than an error', async () => {
      // A typo in a role is a route nobody can reach, not a 500 on every request
      // that touches it.
      h.find.mockResolvedValue([]);

      expect(await h.service.forRole('khong_ton_tai')).toEqual([]);
    });

    it('queries nothing when there is no role at all', async () => {
      expect(await h.service.forRole(undefined)).toEqual([]);
      expect(await h.service.forRole('')).toEqual([]);
      expect(h.find).not.toHaveBeenCalled();
    });

    it('filters on the role it was given', async () => {
      await h.service.forRole('admin');

      expect(h.find.mock.calls[0][0].where).toEqual({ role: 'admin' });
    });

    it('reads the permission name rather than the whole row', async () => {
      await h.service.forRole('admin');

      // The join is what this read costs, so loading every column of a row nobody
      // uses is waste on the hottest read in the request path.
      expect(h.find.mock.calls[0][0].select).toEqual({
        permission: { name: true },
      });
    });
  });

  describe('forUser', () => {
    it('resolves through the user role', async () => {
      h.find.mockResolvedValue([grant('admin', 'user:read')]);

      expect(await h.service.forUser({ id: 'u1', role: 'admin' })).toEqual([
        'user:read',
      ]);
    });

    it('returns nothing for a user with no role', async () => {
      expect(await h.service.forUser({ id: 'u1' })).toEqual([]);
    });

    it('is the same answer as forRole, because permissions live on the role', async () => {
      h.find.mockResolvedValue([grant('admin', 'user:read')]);

      const byUser = await h.service.forUser({ id: 'u1', role: 'admin' });
      const byRole = await h.service.forRole('admin');

      expect(byUser).toEqual(byRole);
    });
  });

  describe('forRoles', () => {
    it('groups the names by role', async () => {
      h.find.mockResolvedValue([
        grant('admin', 'user:read'),
        grant('super_admin', 'user:delete'),
        grant('super_admin', 'user:read'),
      ]);

      const grouped = await h.service.forRoles(['admin', 'super_admin']);

      expect(grouped.get('admin')).toEqual(['user:read']);
      expect(grouped.get('super_admin')).toEqual(['user:delete', 'user:read']);
    });

    it('returns nothing when no roles are asked for', async () => {
      expect((await h.service.forRoles([])).size).toBe(0);
      expect(h.find).not.toHaveBeenCalled();
    });
  });

  describe('setForRole', () => {
    beforeEach(() => {
      vi.spyOn(h.service, 'catalogue').mockResolvedValue([
        { id: 'p1', name: 'user:read' },
        { id: 'p2', name: 'user:delete' },
      ] as never);
    });

    it('replaces the grants rather than adding to them', async () => {
      await h.service.setForRole(Role.Admin, ['user:read']);

      expect(h.delete).toHaveBeenCalledWith(RolePermission, { role: 'admin' });
    });

    it('inserts the ids it resolved', async () => {
      await h.service.setForRole(Role.Admin, ['user:read', 'user:delete']);

      expect(h.insert.mock.calls[0][1]).toEqual([
        { role: 'admin', permissionId: 'p1' },
        { role: 'admin', permissionId: 'p2' },
      ]);
    });

    it('refuses a name that is not in the catalogue', async () => {
      // A typo that quietly granted nothing is how a role loses a permission and
      // nobody finds out until a user cannot do their job.
      await expect(
        h.service.setForRole(Role.Admin, ['user:reed']),
      ).rejects.toThrow(/user:reed/);
    });

    it('names every unknown permission at once, not just the first', async () => {
      await expect(
        h.service.setForRole(Role.Admin, ['a:b', 'c:d']),
      ).rejects.toThrow(/a:b.*c:d/);
    });

    it('writes nothing when a name is unknown', async () => {
      await expect(
        h.service.setForRole(Role.Admin, ['nope']),
      ).rejects.toThrow();
      expect(h.delete).not.toHaveBeenCalled();
    });

    it('clears the role without inserting when given no names', async () => {
      // Removing every permission is a legitimate action and must not be the same
      // as "leave it alone".
      const result = await h.service.setForRole(Role.User, []);

      expect(result).toBe(0);
      expect(h.delete).toHaveBeenCalled();
      expect(h.insert).not.toHaveBeenCalled();
    });

    it('deduplicates a repeated name', async () => {
      const result = await h.service.setForRole(Role.Admin, [
        'user:read',
        'user:read',
      ]);

      expect(result).toBe(1);
    });

    it('does both halves in one transaction', async () => {
      // A delete that commits without its insert leaves the role with no
      // permissions at all, which is a lockout nobody asked for.
      await h.service.setForRole(Role.Admin, ['user:read']);

      expect(h.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('the cached role grants', () => {
    let h: Harness;

    beforeEach(() => {
      h = harness();
      vi.spyOn(h.service, 'catalogue').mockResolvedValue([
        { id: 'p1', name: 'user:read' },
        { id: 'p2', name: 'maintenance:run' },
      ] as never);
    });

    it('keys on the role, not the user', async () => {
      h.find.mockResolvedValue([grant('admin', 'user:read')]);

      await h.service.forRole('admin');

      expect([...h.store.keys()]).toEqual(['role:admin']);
    });

    it('is read once for a role, however many holders ask', async () => {
      // The reason the key is the role: five users with it is still one query.
      h.find.mockResolvedValue([grant('admin', 'user:read')]);

      await h.service.forRole('admin');
      await h.service.forRole('admin');
      await h.service.forUser({ id: 'u1', role: 'admin' });
      await h.service.forUser({ id: 'u2', role: 'admin' });

      expect(h.find).toHaveBeenCalledTimes(1);
    });

    it('caches an empty set, because a plain user is the common case', async () => {
      // Not short-circuited: an empty array is a value, so the longer lifetime
      // applies and the per-request query stops for everybody holding it.
      h.find.mockResolvedValue([]);

      await h.service.forRole('user');
      await h.service.forRole('user');

      expect(h.find).toHaveBeenCalledTimes(1);
      expect(h.store.get('role:user')).toEqual([]);
    });

    it('caches nothing for an absent role', async () => {
      // `cacheKey` drops an empty part, so caching this would file it under a
      // bare `role` key.
      await h.service.forRole('');
      await h.service.forRole(undefined);

      expect(h.store.size).toBe(0);
      expect(h.find).not.toHaveBeenCalled();
    });

    it('drops the entry after a role is rewritten', async () => {
      await h.service.forRole(Role.Admin);
      expect(h.store.has('role:admin')).toBe(true);

      await h.service.setForRole(Role.Admin, ['user:read']);

      expect(h.deletedKeys).toEqual(['role:admin']);
      expect(h.store.has('role:admin')).toBe(false);
    });

    it('makes the new grants visible to the next read', async () => {
      h.find.mockResolvedValue([grant(Role.Admin, 'user:read')]);
      await h.service.forRole(Role.Admin);

      await h.service.setForRole(Role.Admin, ['maintenance:run']);
      h.find.mockResolvedValue([grant(Role.Admin, 'maintenance:run')]);

      await expect(h.service.forRole(Role.Admin)).resolves.toEqual([
        'maintenance:run',
      ]);
    });

    it('drops the entry after the transaction, not inside it', async () => {
      // The ordering is the property. A read landing before the commit refills
      // the entry from the old rows, and a withdrawn permission then keeps
      // working for the rest of the TTL.
      const order: string[] = [];

      h.transaction.mockImplementation(
        async (fn: (m: unknown) => Promise<void>) => {
          await fn(managerOf(h));
          order.push('commit');
        },
      );
      h.cacheDelete.mockImplementation(async () => {
        order.push('invalidate');
      });

      await h.service.setForRole(Role.Admin, ['user:read']);

      expect(order).toEqual(['commit', 'invalidate']);
    });

    it('drops the entry even when the transaction throws', async () => {
      // A rolled back write leaves the old grants in force, and a stale entry on
      // top of them with nobody left to remove it.
      h.transaction.mockRejectedValueOnce(new Error('rollback'));

      await expect(
        h.service.setForRole(Role.Admin, ['user:read']),
      ).rejects.toThrow('rollback');

      expect(h.deletedKeys).toEqual(['role:admin']);
    });

    it('leaves other roles alone', async () => {
      // No pattern delete exists on purpose, so a broad sweep would be a scan of
      // the keyspace on every role change.
      await h.service.setForRole(Role.Admin, ['user:read']);

      expect(h.deletedKeys).toEqual(['role:admin']);
      expect(h.deletedKeys).not.toContain('role:super_admin');
    });
  });
});

/** The manager the fake transaction passes to its callback. */
function managerOf(h: Harness): unknown {
  return { delete: h.delete, insert: h.insert };
}
