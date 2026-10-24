import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { RequestUser } from '../interfaces/index.js';

interface RequestWithUser extends FastifyRequest {
  user?: RequestUser;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestUser | undefined => {
    const request = context.switchToHttp().getRequest<RequestWithUser>();

    return request.user;
  },
);
