import { Role } from './role.enum.js';
import { Permission, ROLE_PERMISSIONS } from './permission.enum.js';

import { describe, expect, it } from 'vitest';

describe('the permission catalogue', () => {
  it('gives every permission a namespaced name', () => {
    // `user:read` rather than `read`, because a flat list eventually holds two
    // unrelated things called `read` and nobody can tell them apart in a diff.
    for (const name of Object.values(Permission)) {
      expect(name).toMatch(
        /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)?$/,
      );
    }
  });

  it('names no permission twice', () => {
    const names = Object.values(Permission);

    expect(new Set(names).size).toBe(names.length);
  });

  it('covers every role the application has', () => {
    // A role with no entry would silently hold nothing, and the guard would
    // refuse every route for whoever holds it.
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(
      Object.values(Role).sort(),
    );
  });
});

describe('role grants', () => {
  it('gives a plain user nothing', () => {
    // The default is deny. A user reaching a guarded route is refused rather
    // than allowed through, so an unseeded permission denies instead of grants.
    expect(ROLE_PERMISSIONS[Role.User]).toEqual([]);
  });

  it('never lists a permission that is not in the catalogue', () => {
    const known = new Set<string>(Object.values(Permission));

    for (const names of Object.values(ROLE_PERMISSIONS)) {
      for (const name of names) {
        expect(known.has(name)).toBe(true);
      }
    }
  });

  it('lists no grant twice within a role', () => {
    for (const names of Object.values(ROLE_PERMISSIONS)) {
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('gives a super admin everything an admin has', () => {
    // A partial hierarchy is the kind of thing that surprises somebody in
    // production: an admin can edit a user but a super admin cannot, which reads
    // as a bug rather than a decision.
    const admin = new Set(ROLE_PERMISSIONS[Role.Admin]);

    for (const name of admin) {
      expect(ROLE_PERMISSIONS[Role.SuperAdmin]).toContain(name);
    }
  });

  it('keeps the destructive and operational permissions off the admin role', () => {
    // Deleting a user and running the retention job are the two things that
    // cannot be undone from the admin screen, so they need the higher role even
    // though the distinction is otherwise only about extra read routes.
    expect(ROLE_PERMISSIONS[Role.Admin]).not.toContain(Permission.UserDelete);
    expect(ROLE_PERMISSIONS[Role.Admin]).not.toContain(
      Permission.MaintenanceRun,
    );
    expect(ROLE_PERMISSIONS[Role.Admin]).not.toContain(
      Permission.MailTemplateWrite,
    );

    expect(ROLE_PERMISSIONS[Role.SuperAdmin]).toContain(Permission.UserDelete);
    expect(ROLE_PERMISSIONS[Role.SuperAdmin]).toContain(
      Permission.MaintenanceRun,
    );
  });

  it('is frozen, so a caller cannot grant a role more permissions at runtime', () => {
    expect(Object.isFrozen(ROLE_PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(ROLE_PERMISSIONS[Role.Admin])).toBe(true);
  });

  it('grants an admin nothing an ordinary user cannot already do', () => {
    // Otherwise the role is decoration and every check against it is a guess.
    const user = new Set(ROLE_PERMISSIONS[Role.User]);

    for (const name of ROLE_PERMISSIONS[Role.Admin]) {
      expect(user.has(name)).toBe(false);
    }
  });
});
