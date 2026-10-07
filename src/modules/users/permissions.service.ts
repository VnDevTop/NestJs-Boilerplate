import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Role } from '../../common/enums/index.js';
import { Permission, RolePermission } from './entities/index.js';

/**
 * Resolves which permissions a role holds.
 *
 * Its own service rather than a method on `UsersService`, because this is the
 * seam Phase 17b caches in front of: `forRole` is the small, shared read that a
 * role permission map answers once, and `forUser` is the per-user read that one
 * request needs. Hiding both in `UsersService` would put them behind a service
 * whose other methods are about user records, and the cache would end up wrapping
 * the wrong thing.
 *
 * A missing or unknown role resolves to an empty set, never an error. The guard
 * treats an empty set as "refused", so a typo in a role is a route nobody can
 * reach rather than a 500 on every request that touches it.
 */
@Injectable()
export class PermissionsService {
  private readonly logger = new Logger(PermissionsService.name);

  constructor(
    @InjectRepository(RolePermission)
    private readonly grants: Repository<RolePermission>,
  ) {}

  /**
   * Every permission one role holds.
   *
   * Cached under `role:<role>` from Phase 17b, because it is the same answer for
   * every user holding that role.
   */
  async forRole(role: string | undefined): Promise<string[]> {
    if (role === undefined || role === '') {
      return [];
    }

    const grants = await this.grants.find({
      where: { role },
      select: { permission: { name: true } },
      relations: { permission: true },
    });

    return grants.map((grant) => grant.permission.name);
  }

  /**
   * Every permission one user holds, resolved through their role.
   *
   * A permission is stored against a role rather than a user, so there is no
   * per-user lookup to make: this is `forRole` with the caller's role attached.
   * Kept as its own method so Phase 17b can cache per user when a deployment
   * needs a change to reach one person without touching the whole role.
   */
  async forUser(user: { id: string; role?: string }): Promise<string[]> {
    return this.forRole(user.role);
  }

  /**
   * The full catalogue, for an admin editing a role.
   *
   * Ordered by name so an admin screen lists the same way twice, which is small
   * but the kind of thing that otherwise gets reported as a bug.
   */
  async catalogue(): Promise<Permission[]> {
    return this.grants.manager
      .getRepository(Permission)
      .find({ order: { name: 'ASC' } });
  }

  /**
   * Replaces a role's grants with exactly the names given.
   *
   * Unknown names are an error rather than a silent skip: a typo that quietly
   * granted nothing is how a role loses a permission nobody notices until a user
   * cannot do their job. Reported as a single message naming every offender.
   */
  async setForRole(role: Role, names: readonly string[]): Promise<number> {
    const known = await this.catalogue();
    const byName = new Map(
      known.map((permission) => [permission.name, permission.id]),
    );

    const missing = names.filter((name) => !byName.has(name));

    if (missing.length > 0) {
      throw new Error(
        `Unknown permission${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
      );
    }

    const permissionIds = [...new Set(names)].map((name) => byName.get(name)!);

    await this.grants.manager.transaction(async (manager) => {
      await manager.delete(RolePermission, { role });

      if (permissionIds.length > 0) {
        await manager.insert(
          RolePermission,
          permissionIds.map((permissionId) => ({ role, permissionId })),
        );
      }
    });

    return permissionIds.length;
  }

  /** Grants for several roles at once, for a screen showing more than one. */
  async forRoles(roles: readonly string[]): Promise<Map<string, string[]>> {
    if (roles.length === 0) {
      return new Map();
    }

    const grants = await this.grants.find({
      where: { role: In([...roles]) },
      select: { role: true, permission: { name: true } },
      relations: { permission: true },
    });

    const grouped = new Map<string, string[]>();

    for (const grant of grants) {
      const list = grouped.get(grant.role) ?? [];
      list.push(grant.permission.name);
      grouped.set(grant.role, list);
    }

    return grouped;
  }
}
