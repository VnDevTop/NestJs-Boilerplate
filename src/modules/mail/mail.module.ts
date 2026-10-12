import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { MetricsModule } from '../../core/metrics/index.js';
import { mailConfig, type MailConfig } from '../../configs/mail.config.js';
import {
  MAIL_TRANSPORT,
  MailService,
  selectTransport,
} from './mail.service.js';
import type { MailTransport } from './transports/transport.interface.js';

/**
 * Outbound mail.
 *
 * The config is registered with `forFeature` rather than loaded globally, so an
 * app that never sends mail carries no mail configuration, and the module imports
 * with none of the provider packages installed: each transport resolves its own
 * package through `loadOptional` and the factory falls back to the memory one.
 */
@Module({
  // `MetricsModule` for the send counters. It is a plain module import rather than
  // a global one so this module still resolves on its own in a test that builds
  // only the mail half of the graph — which is how `HealthModule` gets a mail
  // transport without dragging the application in.
  imports: [ConfigModule.forFeature(mailConfig), MetricsModule],
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): MailTransport =>
        selectTransport(configService.getOrThrow<MailConfig>('mail')).transport,
    },
    MailService,
  ],
  exports: [MailService],
})
export class MailModule {}
