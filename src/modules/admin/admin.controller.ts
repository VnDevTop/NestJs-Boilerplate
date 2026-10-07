import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { ManagerOnly, Permissions } from '../../common/decorators/index.js';
import { Permission } from '../../common/enums/index.js';
import { AdminService } from './admin.service.js';
import {
  AdminDashboardResponseDto,
  AdminHealthResponseDto,
} from './dto/index.js';

@ApiTags('Admin')
@ApiBearerAuth('access-token')
@ManagerOnly()
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('health')
  @Permissions(Permission.AdminHealthRead)
  @ApiOperation({ summary: 'Get admin module health status' })
  @ApiOkResponse({ type: AdminHealthResponseDto })
  getHealth(): AdminHealthResponseDto {
    return this.adminService.getHealth();
  }

  @Get('dashboard')
  @Permissions(Permission.AdminHealthRead)
  @ApiOperation({ summary: 'Get admin dashboard placeholder data' })
  @ApiOkResponse({ type: AdminDashboardResponseDto })
  getDashboard(): AdminDashboardResponseDto {
    return this.adminService.getDashboard();
  }
}
