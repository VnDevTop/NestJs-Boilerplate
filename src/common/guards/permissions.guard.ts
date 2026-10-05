import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

import { PERMISSIONS_KEY } from '../constants/index.js';
import type { RequestUser } from '../interfaces/index.js';

interface RequestWithUser extends Request {
  user?: RequestUser;
}

/**
 * Refuses a request whose caller lacks a permission the route named.
 *
 * The rule is deny by default, and it has two halves that are easy to get
 * backwards. A route that names no permissions is open, because most routes do
 * not and requiring a list on each one would mean a decorator nobody remembers
 * to add. A route that names some is closed to anyone without all of them, and a
 * user with no permissions at all is refused rather than waved through, so an
 * unseeded permission locks a route instead of unlocking it.
 *
 * Throws rather than returning false, unlike `RolesGuard` next to it. A false
 * becomes a bare 403 with no body, which tells an operator that something denied
 * the request and not which permission was missing.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const held = request.user?.permissions;

    // No user at all means the JWT guard let something through, or the route is
    // public. Either way there is nothing to grant permission with, so the answer
    // is no rather than a crash on `held.includes`.
    if (held === undefined) {
      throw new ForbiddenException(
        `Requires ${requiredPermissions.join(', ')}`,
      );
    }

    const missing = requiredPermissions.filter(
      (permission) => !held.includes(permission),
    );

    if (missing.length > 0) {
      throw new ForbiddenException(`Missing permission: ${missing.join(', ')}`);
    }

    return true;
  }
}
