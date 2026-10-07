import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { describe, expect, it } from 'vitest';

import { PERMISSIONS_KEY } from '../constants/index.js';
import type { RequestUser } from '../interfaces/index.js';
import { PermissionsGuard } from './permissions.guard.js';

function context(options: {
  required?: string[];
  user?: Partial<RequestUser> | null;
}): ExecutionContext {
  const request = {
    user: options.user === null ? undefined : options.user,
  };

  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => 'handler',
    getClass: () => 'class',
  } as unknown as ExecutionContext;
}

/** A reflector that answers with the permissions the route declares. */
function reflectorFor(required: string[] | undefined): Reflector {
  return {
    getAllAndOverride: (key: unknown) =>
      key === PERMISSIONS_KEY ? required : undefined,
  } as unknown as Reflector;
}

function guard(required?: string[]): PermissionsGuard {
  return new PermissionsGuard(reflectorFor(required));
}

const holder: RequestUser = {
  id: 'u1',
  email: 'a@x.com',
  role: 'admin',
  isManager: false,
  isActive: true,
  permissions: ['user:read', 'user:write'],
};

describe('PermissionsGuard', () => {
  describe('a route that names no permissions', () => {
    it('is allowed, so a forgotten decorator does not lock the application', () => {
      expect(guard(undefined).canActivate(context({}))).toBe(true);
    });

    it('is allowed when the list is empty', () => {
      expect(guard([]).canActivate(context({ user: holder }))).toBe(true);
    });

    it('is allowed even for a user with no permissions at all', () => {
      // Most routes do not declare permissions, so a plain user is not stopped
      // by every route in the application.
      const user = { ...holder, permissions: [] };

      expect(guard([]).canActivate(context({ user }))).toBe(true);
    });
  });

  describe('a route that names permissions', () => {
    it('lets a caller holding all of them through', () => {
      expect(guard(['user:read']).canActivate(context({ user: holder }))).toBe(
        true,
      );
    });

    it('lets a caller holding several through', () => {
      const guard_ = guard(['user:read', 'user:write']);

      expect(guard_.canActivate(context({ user: holder }))).toBe(true);
    });

    it('refuses a caller missing one', () => {
      const guard_ = guard(['user:delete']);

      expect(() => guard_.canActivate(context({ user: holder }))).toThrow(
        ForbiddenException,
      );
    });

    it('names the permission that was missing', () => {
      // A bare 403 tells an operator something denied the request and not what to
      // grant, which is the difference between a five-minute fix and an hour.
      const guard_ = guard(['user:delete']);

      expect(() => guard_.canActivate(context({ user: holder }))).toThrow(
        /user:delete/,
      );
    });

    it('refuses a user with no permissions, rather than treating it as a pass', () => {
      // The direction that matters. An unseeded permission has to lock a route,
      // otherwise forgetting to seed it silently grants access.
      const user = { ...holder, permissions: [] };

      expect(() => guard(['user:read']).canActivate(context({ user }))).toThrow(
        ForbiddenException,
      );
    });

    it('refuses when there is no user at all', () => {
      // The JWT guard let this through, or the route is public. Neither grants
      // permission, and reading `undefined.includes` would be a 500.
      expect(() =>
        guard(['user:read']).canActivate(context({ user: null })),
      ).toThrow(ForbiddenException);
    });

    it('requires every permission, not any one of them', () => {
      // Holding `user:read` is not a reason to pass a route that also needs
      // `user:delete`.
      const user = { ...holder, permissions: ['user:read'] };

      expect(() =>
        guard(['user:read', 'user:delete']).canActivate(context({ user })),
      ).toThrow(/user:delete/);
    });

    it('reports only the permissions that are actually missing', () => {
      const guard_ = guard(['user:read', 'user:delete']);

      expect(() => guard_.canActivate(context({ user: holder }))).toThrow(
        /Missing permission: user:delete/,
      );
    });
  });

  describe('an empty permissions array on the user', () => {
    it('is a refusal rather than an error', () => {
      // `RequestUser.permissions` is always an array so a token minted before the
      // claim existed is refused, not crashed on.
      const user = { ...holder, permissions: [] };
      let thrown: unknown;

      try {
        guard(['user:read']).canActivate(context({ user }));
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ForbiddenException);
    });
  });
});
