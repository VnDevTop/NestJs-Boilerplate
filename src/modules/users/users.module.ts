import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Permission, RolePermission, User } from './entities/index.js';
import { UsersController } from './users.controller.js';
import { PermissionsService } from './permissions.service.js';
import { UsersService } from './users.service.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([User, Permission, RolePermission])],
  controllers: [UsersController],
  providers: [UsersService, PermissionsService],
  exports: [UsersService, PermissionsService],
})
export class UsersModule {}
