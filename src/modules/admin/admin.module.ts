import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../audit/audit.module.js';
import { MaintenanceLog } from '../maintenance/entities/maintenance-log.entity.js';
import { MaintenanceModule } from '../maintenance/index.js';
import { QueueModule } from '../queue/index.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { AdminRetentionController } from './retention.controller.js';
import { AdminRolesController } from './roles.controller.js';

@Module({
  // `QueueModule` for JOB_QUEUE, so the run route enqueues rather than opening a
  // second execution path, and `MaintenanceModule` for the service it drives.
  // Both sit below this module in the graph, which is why the retention routes
  // live here instead of beside the retention code.
  imports: [
    QueueModule,
    MaintenanceModule,
    TypeOrmModule.forFeature([MaintenanceLog]),
    // For the audit interceptor `AdminRolesController` binds. One-directional, for
    // the same reason as in `UsersModule`: `AuditModule` imports nothing.
    AuditModule,
  ],
  controllers: [
    AdminController,
    AdminRetentionController,
    AdminRolesController,
  ],
  providers: [AdminService],
})
export class AdminModule {}
