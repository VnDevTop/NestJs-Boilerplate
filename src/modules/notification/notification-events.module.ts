import { Module } from '@nestjs/common';

import { QueueModule } from '../queue/index.js';
import { NotificationController } from './notification.controller.js';
import { NotificationEventsService } from './notification-events.service.js';
import { NotificationModule } from './notification.module.js';

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
 *
 * **`NotificationModule` is re-exported, not `NotificationPreferencesService`.** The
 * preferences service belongs to the module below the queue, and Nest only permits
 * re-exporting what this module provides itself or a module it imports — naming the
 * service directly is rejected at boot with `UnknownExportException`, which reads as
 * a missing provider and is not one. Re-exporting the module hands over everything it
 * already exports, which is what `UsersService` needs when it opts a subject out of
 * an alert.
 */
@Module({
  imports: [QueueModule, NotificationModule],
  controllers: [NotificationController],
  providers: [NotificationEventsService],
  exports: [NotificationEventsService, NotificationModule],
})
export class NotificationEventsModule {}
