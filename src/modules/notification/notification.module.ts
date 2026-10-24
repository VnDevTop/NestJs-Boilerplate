import { HttpModule, HttpService } from '@nestjs/axios';
import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MetricsModule } from '../../core/metrics/index.js';
import { notificationConfig } from '../../configs/notification.config.js';
import { MailModule, MailService } from '../mail/index.js';
import {
  DiscordNotificationChannel,
  EmailNotificationChannel,
  SlackNotificationChannel,
  TelegramNotificationChannel,
  selectChannels,
  type NotificationChannel,
} from './channels/index.js';
import { NotificationLog, NotificationPreference } from './entities/index.js';
import { NotificationLogService } from './notification-log.service.js';
import { NotificationPreferencesService } from './notification-preferences.service.js';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_LOG_WRITER,
  NotificationService,
} from './notification.service.js';

const logger = new Logger('NotificationModule');

/**
 * Builds the enabled channel list.
 *
 * Exported as a function rather than inlined in the provider so it can be tested
 * without standing up the module: the enabled-set rules are a pure function of a
 * config object plus a set of channels, and that is where a mistake would live.
 *
 * The three webhook channels are constructed unconditionally and then filtered by
 * `selectChannels`. Constructing one is a few field reads and no I/O — `HttpService`
 * is shared and already connected — so building all three and dropping the disabled
 * ones costs nothing, and it leaves the filter as the single place that decides what
 * is enabled rather than spreading that decision across three constructor guards.
 */
export function buildChannels(
  config: NotificationConfig,
  http: HttpService,
  mailer: MailService,
): NotificationChannel[] {
  const webhooks: NotificationChannel[] = [
    new TelegramNotificationChannel(http, config),
    new SlackNotificationChannel(http, config),
    new DiscordNotificationChannel(http, config),
  ];

  const channels = selectChannels(
    config,
    webhooks,
    new EmailNotificationChannel(mailer, config),
  );

  if (config.enabled) {
    logger.log(
      channels.length === 0
        ? 'Notifications are enabled but no channel is configured, so nothing will be delivered'
        : `Notifications on ${channels.length} channel(s): ${channels
            .map((channel) => channel.name)
            .join(', ')}`,
    );
  }

  return channels;
}

type NotificationConfig = ConfigType<typeof notificationConfig>;

/**
 * Notifications.
 *
 * Owns the config registration, the two entities and the delivery service.
 *
 * **Deliberately does not import `QueueModule`**, for the same reason
 * `MaintenanceModule` does not: the processor is injected into the queue's router, so
 * this module sits *below* the queue in the graph. The service that hands a
 * notification to the queue therefore lives in `NotificationEventsModule`, above it,
 * and that is the only thing in this module an emit site needs.
 *
 * The channels are built by one factory from the config rather than five conditional
 * providers, so a channel nobody enabled costs no instance and no branch in the
 * delivery loop.
 */
@Module({
  imports: [
    ConfigModule.forFeature(notificationConfig),
    TypeOrmModule.forFeature([NotificationPreference, NotificationLog]),
    // Outbound HTTP client for the three webhook channels.
    HttpModule,
    // For the email channel, which delegates rather than speaking SMTP itself.
    MailModule,
    // For the delivery counters. One direction only, so no cycle.
    MetricsModule,
  ],
  providers: [
    NotificationPreferencesService,
    NotificationLogService,
    {
      provide: NOTIFICATION_LOG_WRITER,
      inject: [NotificationLogService],
      useFactory: (logs: NotificationLogService) => logs,
    },
    {
      provide: NOTIFICATION_CHANNELS,
      inject: [HttpService, MailService, notificationConfig.KEY],
      useFactory: (
        http: HttpService,
        mailer: MailService,
        config: NotificationConfig,
      ) => buildChannels(config, http, mailer),
    },
    NotificationService,
  ],
  exports: [
    NotificationService,
    NotificationPreferencesService,
    NotificationLogService,
    NOTIFICATION_CHANNELS,
    NOTIFICATION_LOG_WRITER,
  ],
})
export class NotificationModule {}
