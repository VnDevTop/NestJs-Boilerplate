import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { retentionConfig } from '../../configs/retention.config.js';
import { QueueModule } from '../queue/queue.module.js';
import { RetentionScheduler } from './scheduler/retention.scheduler.js';

/**
 * The scheduled entry point for retention.
 *
 * Exists as its own module because it has to sit above `QueueModule` in the
 * import graph: it enqueues through `JOB_QUEUE`, while `QueueModule` imports
 * `MaintenanceModule` to get the processor that runs the job. Putting this
 * provider in `MaintenanceModule` would close that loop, and `forwardRef` would
 * hide the loop rather than remove it.
 *
 * Separate from `MaintenanceModule` on purpose, so the cost of this one is paid
 * by an app that never schedules anything: `MaintenanceModule` still works on its
 * own for the admin route, and this module is what an application imports when it
 * wants the job to fire by itself.
 *
 * It registers the `retention` configuration namespace itself rather than
 * inheriting it from `MaintenanceModule`. A dynamic `ConfigModule.forFeature`
 * publishes its providers to the module that calls it, and importing a sibling
 * does not republish them — so a scheduler asking for `CONFIGURATION(retention)`
 * gets "is that part of the current module?" at boot, and the answer is no.
 * Every module registers the configuration it injects.
 */
@Module({
  imports: [QueueModule, ConfigModule.forFeature(retentionConfig)],
  providers: [RetentionScheduler],
  exports: [RetentionScheduler],
})
export class MaintenanceSchedulerModule {}
