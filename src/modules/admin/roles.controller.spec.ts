import { BadRequestException } from '@nestjs/common';
import { PERMISSIONS_KEY } from '../../common/constants/index.js';
import {
  Permission,
  ROLE_PERMISSIONS,
  Role,
} from '../../common/enums/index.js';
import type { PermissionsService } from '../users/permissions.service.js';
import { AdminRolesController } from './roles.controller.js';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two properties are worth defending and neither shows up in a response body.
 *
 * The route exists because writing grants in SQL bypasses the cache invalidation
 * that follows a write through the application, so the change silently waits out a
 * TTL. What that means is: the write has to go through `setForRole`, which is the
 * only path that drops the cached entry.
 *
 * And the response has to be read back rather than echoed, because echoing the
 * request reports what the operator asked for rather than what the role now holds.
 */

function harness(initial: string[] = ['user:read']) {
  let grants = [...initial];

  const permissionsService = {
    forRole: vi.fn(async (role: string) =>
      role === 'admin' ? [...grants] : [],
    ),
    setForRole: vi.fn(async (_role: string, names: readonly string[]) => {
      grants = [...new Set(names)];

      return grants.length;
    }),
  };

  const controller = new AdminRolesController(
    permissionsService as unknown as PermissionsService,
  );

  return { controller, permissionsService, current: () => grants };
}

describe('reading a role', () => {
  it('returns what the role holds', async () => {
    const h = harness(['user:read', 'user:write']);

    const result = await h.controller.read(Role.Admin);

    expect(result).toEqual({
      role: Role.Admin,
      permissions: ['user:read', 'user:write'],
      applied: 2,
    });
  });

  it('returns an empty set for a role with no grants, rather than an error', async () => {
    // A role that holds nothing is a role nobody can reach, which is a valid state
    // and not a missing one.
    const h = harness();

    const result = await h.controller.read(Role.User);

    expect(result.permissions).toEqual([]);
    expect(result.applied).toBe(0);
  });
});

describe('replacing a role', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  it('writes through setForRole, which is the path that invalidates', async () => {
    // The whole reason the route exists. `setForRole` drops the cached grant set
    // after the transaction; a write that skipped it would leave the change waiting
    // out the TTL.
    await h.controller.replace(Role.Admin, {
      permissions: ['user:read', 'user:delete'],
    } as never);

    expect(h.permissionsService.setForRole).toHaveBeenCalledWith(Role.Admin, [
      'user:read',
      'user:delete',
    ]);
  });

  it('reports what is held afterwards, not what was asked for', async () => {
    // Echoing the request would report the operator's intent rather than the
    // state, and the difference between the two is what they need to see.
    const result = await h.controller.replace(Role.Admin, {
      permissions: ['user:read', 'user:read', 'user:write'],
    } as never);

    expect(result.permissions).toEqual(['user:read', 'user:write']);
    expect(result.applied).toBe(2);
  });

  it('accepts an empty list, which strips every grant', async () => {
    const result = await h.controller.replace(Role.Admin, {
      permissions: [],
    } as never);

    expect(result.permissions).toEqual([]);
  });

  it('refuses a body that is not a list', async () => {
    // Without the check, a client sending `{permissions: "user:read"}` would have
    // a string iterated character by character and end up with grants named `u`,
    // `s`, `e`, `r`...
    await expect(
      h.controller.replace(Role.Admin, {
        permissions: 'user:read',
      } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses a body with no list at all', async () => {
    await expect(h.controller.replace(Role.Admin, {} as never)).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('what each route requires', () => {
  it('guards the read with role:read', () => {
    const required = Reflect.getMetadata(
      PERMISSIONS_KEY,
      AdminRolesController.prototype.read,
    );

    expect(required).toEqual([Permission.RoleRead]);
  });

  it('guards the write with role:write', () => {
    const required = Reflect.getMetadata(
      PERMISSIONS_KEY,
      AdminRolesController.prototype.replace,
    );

    expect(required).toEqual([Permission.RoleWrite]);
  });

  it('does not let the read route grant anything', () => {
    // A mistake here would be the read route carrying the write permission, which
    // would hand every administrator the ability to edit roles.
    const read = Reflect.getMetadata(
      PERMISSIONS_KEY,
      AdminRolesController.prototype.read,
    );

    expect(read).not.toContain(Permission.RoleWrite);
  });

  it('keeps role:write away from the administrator role', () => {
    // Granting it to `Admin` would let one administrator grant themselves the
    // permissions of a super administrator.
    expect(ROLE_PERMISSIONS[Role.Admin]).not.toContain(Permission.RoleWrite);
    expect(ROLE_PERMISSIONS[Role.SuperAdmin]).toContain(Permission.RoleWrite);
  });
});
