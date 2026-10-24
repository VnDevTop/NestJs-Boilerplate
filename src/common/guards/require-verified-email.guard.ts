import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import { EMAIL_VERIFIED_KEY } from '../constants/index.js';
import type { RequestUser } from '../interfaces/index.js';

interface RequestWithUser extends FastifyRequest {
  user?: RequestUser;
}

/**
 * Refuses a request from an account that has not confirmed its address.
 *
 * **Reads the flag the strategy already resolved.** That is the whole reason the
 * flag is on the cached projection rather than looked up here: a guard that reads
 * the database turns an authorization check into a query on every request, which is
 * the cost Phase 17b exists to remove. It is a cache read, not a table read, and it
 * is already being done.
 *
 * **403, not 401.** The caller is authenticated; they are simply not allowed this
 * yet. A 401 would tell a client to refresh its token, which would fail, and a
 * client that retries on 401 is how a gate like this ends up looking like a
 * session bug.
 *
 * **A missing user is refused rather than waved through.** The JWT guard runs
 * first, so this means the route is public and the decorator was misapplied —
 * which is a programming error that should be loud.
 */
@Injectable()
export class RequireVerifiedEmailGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(
      EMAIL_VERIFIED_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    if (user === undefined) {
      throw new ForbiddenException(
        'This action requires a confirmed email address',
      );
    }

    if (!user.isEmailVerified) {
      // The message says how to fix it, because a 403 with no explanation on a
      // route the documentation says is authenticated reads as a bug report.
      throw new ForbiddenException(
        'Confirm your email address before using this action. ' +
          'Request a new link from POST /auth/resend-verification.',
      );
    }

    return true;
  }
}
