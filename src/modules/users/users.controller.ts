import {
  Body,
  Controller,
  UseInterceptors,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import {
  Audited,
  CurrentUser,
  Permissions,
  Roles,
} from '../../common/decorators/index.js';
import { Idempotent } from '../../common/guards/index.js';
import { AuditInterceptor } from '../audit/audit.interceptor.js';
import type { RequestUser } from '../../common/interfaces/index.js';
import { Permission, Role } from '../../common/enums/index.js';
import { CreateUserDto, UpdateUserDto, UserResponseDto } from './dto/index.js';
import { UsersService } from './users.service.js';

@ApiTags('Users')
@ApiBearerAuth('access-token')
// Bound at the controller, deciding per route from `@Audited()`. A route in here
// without the decorator is still unaudited — `audit-policy.spec.ts` reads the real
// handler metadata to catch that, for the same reason the verified-email gate has
// one: a convention nobody checks is a convention that erodes.
@UseInterceptors(AuditInterceptor)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // Idempotent because a retry here creates a second person. The client's retry is
  // the honest reason: it timed out, it does not know whether the first one landed,
  // and without this it has no way to find out without issuing a second POST.
  @Idempotent()
  @Audited({
    action: 'users.create',
    targetType: 'user',
    // A create only learns the id from what it created.
    targetIdFrom: ['result'],
  })
  @Roles(Role.Admin, Role.SuperAdmin)
  @Permissions(Permission.UserWrite)
  @Post()
  @ApiOperation({ summary: 'Create a user' })
  @ApiOkResponse({ type: UserResponseDto })
  create(@Body() createUserDto: CreateUserDto): Promise<UserResponseDto> {
    return this.usersService.create(createUserDto);
  }

  @Roles(Role.Admin, Role.SuperAdmin)
  @Get()
  @ApiOperation({ summary: 'Get all users' })
  @ApiOkResponse({ type: UserResponseDto, isArray: true })
  findAll(): Promise<UserResponseDto[]> {
    return this.usersService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get user profile by id' })
  @ApiOkResponse({ type: UserResponseDto })
  findProfile(@Param('id') id: string): Promise<UserResponseDto> {
    return this.usersService.findProfileById(id);
  }

  @Audited({
    action: 'users.update',
    targetType: 'user',
    targetIdFrom: [['param', 'id']],
  })
  @Roles(Role.Admin, Role.SuperAdmin)
  @Permissions(Permission.UserWrite)
  @Patch(':id')
  @ApiOperation({ summary: 'Update a user' })
  @ApiOkResponse({ type: UserResponseDto })
  update(
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    return this.usersService.update(id, updateUserDto);
  }

  // A retry after a lost 204 answers 404, which a client reads as "the delete
  // failed" when in fact it is the second delete. This is the exact confusion the
  // header exists to remove.
  @Idempotent()
  @Audited({
    action: 'users.delete',
    targetType: 'user',
    targetIdFrom: [['param', 'id']],
    // A 204 has nothing to diff, and diffing it would store an empty object that
    // reads as "nothing changed" rather than "the row is gone".
    diffResponse: false,
  })
  @Roles(Role.Admin, Role.SuperAdmin)
  @Permissions(Permission.UserDelete)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete a user' })
  @ApiNoContentResponse({ description: 'User deleted successfully' })
  remove(
    @Param('id') id: string,
    @CurrentUser() currentUser: RequestUser,
  ): Promise<void> {
    // The caller is passed through so the notification names who did it. An alert
    // reading "account deleted" is half the information; one naming an
    // administrator is the other half, and it is the difference between a routine
    // offboarding and an incident.
    return this.usersService.softDelete(id, currentUser.email);
  }
}
