import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import { MANAGER_ONLY_KEY } from '../constants/index.js';
import { RequestUser } from '../interfaces/index.js';

interface RequestWithUser extends FastifyRequest {
  user?: RequestUser;
}

@Injectable()
export class ManagerGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const managerOnly = this.reflector.getAllAndOverride<boolean>(
      MANAGER_ONLY_KEY,
      [context.getHandler(), context.getClass()],
    );

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const isAdminPath = this.isAdminPath(
      (request.url ?? '').split('?')[0] ?? '',
    );
    const requiresManager = managerOnly || isAdminPath;

    if (!requiresManager) {
      return true;
    }

    return request.user?.isManager === true;
  }

  private isAdminPath(path: string): boolean {
    return /(^|\/)admin(\/|$)/.test(path);
  }
}
