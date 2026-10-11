import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../audit/audit.module.js';
import { NotificationEventsModule } from '../notification/notification-events.module.js';
import { Permission, RolePermission, User } from './entities/index.js';
import { UsersController } from './users.controller.js';
import { PermissionsService } from './permissions.service.js';
import { UsersService } from './users.service.js';

/**
 * Global, because the auth strategy reads `UsersService` and the permission guard
 * reads `PermissionsService`, and both are needed in modules that have no reason to
 * import a users module.
 *
 * `NotificationEventsModule` is imported for one reason: `softDelete` tells the
 * operators an account was removed. That import is what pulls the queue in here,
 * and it is the one place in this module where the graph grows sideways — which is
 * acceptable because the module is already global and the queue is imported by the
 * root regardless.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([User, Permission, RolePermission]),
    NotificationEventsModule,
    // For the audit interceptor `UsersController` binds. `AuditModule` imports
    // nothing but TypeORM, so this is one-directional — the direction that matters.
    AuditModule,
  ],
  controllers: [UsersController],
  providers: [UsersService, PermissionsService],
  exports: [UsersService, PermissionsService],
})
export class UsersModule {}
