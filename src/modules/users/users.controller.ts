import {
  Body,
  Controller,
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

import { Permissions, Roles } from '../../common/decorators/index.js';
import { Permission, Role } from '../../common/enums/index.js';
import { CreateUserDto, UpdateUserDto, UserResponseDto } from './dto/index.js';
import { UsersService } from './users.service.js';

@ApiTags('Users')
@ApiBearerAuth('access-token')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

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

  @Roles(Role.Admin, Role.SuperAdmin)
  @Permissions(Permission.UserDelete)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete a user' })
  @ApiNoContentResponse({ description: 'User deleted successfully' })
  remove(@Param('id') id: string): Promise<void> {
    return this.usersService.softDelete(id);
  }
}
