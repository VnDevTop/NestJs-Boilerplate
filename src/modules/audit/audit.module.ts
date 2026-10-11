import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditService } from './audit.service.js';
import { AuditLog } from './entities/index.js';

/**
 * The audit trail.
 *
 * **Exports the service and nothing else.** An interceptor, a subscriber and an
 * admin query surface are all later phases; the module is here for the entity and
 * the writer so those have somewhere to attach to, and so the migration and the
 * retention rule have a home that is not somebody else's table.
 *
 * Imports nothing. A trail that depended on the queue, on mail or on any other
 * module would be a trail whose writes stop when that module's dependency stops —
 * and a trail that goes quiet during an incident is the one you find out about
 * afterwards. It writes to the database it is recording the database's writes to,
 * and that is the whole dependency list.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog])],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
