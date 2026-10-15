import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../audit/audit.module.js';
import { MaintenanceLog } from '../maintenance/entities/maintenance-log.entity.js';
import { MaintenanceModule } from '../maintenance/index.js';
import { MailModule } from '../mail/mail.module.js';
import { QueueModule } from '../queue/index.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { AdminMailTemplatesController } from './mail-templates.controller.js';
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
    // Phase 22. `MailModule` for `MailTemplateStore`, which the template routes read
    // and write through. It is a one-directional import for the same reason as
    // `AuditModule`: the mail module does not know the admin routes exist.
    MailModule,
  ],
  controllers: [
    AdminController,
    AdminRetentionController,
    AdminRolesController,
    AdminMailTemplatesController,
  ],
  providers: [AdminService],
})
export class AdminModule {}
