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
}

const grant = (role: string, name: string): Partial<RolePermission> =>
  ({ role, permission: { name } }) as Partial<RolePermission>;

function harness(): Harness {
  const find = vi.fn().mockResolvedValue([]);
  const remove = vi.fn().mockResolvedValue({ affected: 0 });
  const insert = vi.fn().mockResolvedValue({ identifiers: [] });
  const findPermissions = vi.fn().mockResolvedValue([]);

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
    service: new PermissionsService(grants),
    find,
    delete: remove,
    insert,
    transaction: manager.transaction,
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
});
