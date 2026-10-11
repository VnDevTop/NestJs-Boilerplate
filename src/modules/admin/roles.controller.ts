import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Put,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { Audited, Permissions } from '../../common/decorators/index.js';
import { Idempotent } from '../../common/guards/index.js';
import { Permission, Role } from '../../common/enums/index.js';
import { AuditInterceptor } from '../audit/audit.interceptor.js';
import { PermissionsService } from '../users/permissions.service.js';
import { RolePermissionsDto, SetRolePermissionsDto } from './dto/index.js';

/**
 * Which permissions a role holds.
 *
 * The route exists so that changing a role's grants goes *through the application*
 * rather than around it. Until it existed the only way to change them was SQL
 * against `role_permissions`, and a write that bypasses the application also
 * bypasses the cache invalidation that follows one — so the change took effect only
 * when the cached entry happened to expire. Having the route makes the
 * application's own write path the normal one, which is what keeps the cache
 * correct.
 *
 * It cannot catch an operator who still goes straight to SQL. That window is
 * documented rather than closed, because nothing inside the application can see a
 * write it did not make.
 */
@ApiTags('Admin')
// Bound at the controller, per route from `@Audited()` — the same arrangement as
// `UsersController`, for the same reason.
@UseInterceptors(AuditInterceptor)
@Controller('admin/roles')
export class AdminRolesController {
  constructor(private readonly permissionsService: PermissionsService) {}

  @Get(':role/permissions')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Read the permissions a role holds' })
  @ApiParam({ name: 'role', enum: Role })
  @ApiOkResponse({ type: RolePermissionsDto })
  @Permissions(Permission.RoleRead)
  async read(
    @Param('role', new ParseEnumPipe(Role, { optional: false }))
    role: Role,
  ): Promise<RolePermissionsDto> {
    const permissions = await this.permissionsService.forRole(role);

    return { role, permissions, applied: permissions.length };
  }

  /**
   * Replaces a role's grants with exactly the names given.
   *
   * `ParseEnumPipe` rather than a free string, because an unknown role reaching
   * `setForRole` would be written as a role nobody holds and would quietly grant
   * nothing. Refusing it here turns a typo into an error instead of a role that
   * can reach no route and looks merely empty.
   */
  // Audited because a grant is the most consequential thing in this application:
  // it is how somebody reaches a route they could not otherwise reach. A row that
  // says who widened what, and what it went from, is the difference between an
  // incident and a mystery.
  // Replayable, because a replace is a full-set write and a client that loses the
  // response has no way to confirm what it granted without sending it all again.
  @Idempotent()
  @Audited({
    action: 'roles.permissions.replace',
    targetType: 'role',
    targetIdFrom: [['param', 'role']],
  })
  @Put(':role/permissions')
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Replace a role's grants with exactly the permissions given",
  })
  @ApiParam({ name: 'role', enum: Role })
  @ApiOkResponse({ type: RolePermissionsDto })
  @Permissions(Permission.RoleWrite)
  async replace(
    @Param('role', new ParseEnumPipe(Role, { optional: false }))
    role: Role,
    @Body() body: SetRolePermissionsDto,
  ): Promise<RolePermissionsDto> {
    if (!Array.isArray(body?.permissions)) {
      throw new BadRequestException('permissions must be a list of names');
    }

    const applied = await this.permissionsService.setForRole(
      role,
      body.permissions,
    );

    // Read back rather than echoing the request. The request is what was asked
    // for and this is what was written, and the difference between them is exactly
    // what an operator needs to see.
    return {
      role,
      permissions: await this.permissionsService.forRole(role),
      applied,
    };
  }
}
