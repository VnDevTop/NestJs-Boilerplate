import { Module } from '@nestjs/common';

import { QueueModule } from '../queue/index.js';
import { NotificationController } from './notification.controller.js';
import { NotificationEventsService } from './notification-events.service.js';
import { NotificationModule } from './notification.module.js';
import { NotificationPreferencesService } from './notification-preferences.service.js';

/**
 * The emit side, and the caller's own preferences.
 *
 * **Sits above the queue** where `NotificationModule` sits below it. This is the
 * module a business service imports: it needs the queue to enqueue and the delivery
 * service to be reachable, and importing both from one module is what keeps the
 * dependency pointing one way.
 *
 * The controller lives here rather than in `NotificationModule` for the same reason.
 * The preferences service is below the queue and the routes need no queue at all, so
 * placing them here groups them with the emit path a caller reaches for, and leaves
 * the lower module holding only what delivery needs.
 */
@Module({
  imports: [QueueModule, NotificationModule],
  controllers: [NotificationController],
  providers: [NotificationEventsService],
  exports: [NotificationEventsService, NotificationPreferencesService],
})
export class NotificationEventsModule {}
