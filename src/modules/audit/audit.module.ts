import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditInterceptor } from './audit.interceptor.js';
import { AuditService } from './audit.service.js';
import { AuditLog } from './entities/index.js';

/**
 * The audit trail.
 *
 * **Imports nothing but TypeORM.** A trail that depended on the queue or on mail
 * would be a trail whose writes stop when that dependency stops — and a trail that
 * goes quiet during an incident is the one you find out about afterwards. It writes
 * to the database it is recording the database's writes to, and that is the whole
 * dependency list.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog])],
  providers: [AuditService, AuditInterceptor],
  // The interceptor as well as the service: controllers that audit bind it with
  // `@UseInterceptors(AuditInterceptor)`, and they have to be able to resolve it
  // from this module rather than from the root.
  exports: [AuditService, AuditInterceptor],
})
export class AuditModule {}
