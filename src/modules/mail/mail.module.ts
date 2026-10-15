import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MetricsModule } from '../../core/metrics/index.js';
import { mailConfig, type MailConfig } from '../../configs/mail.config.js';
import {
  EmailTemplate,
  MailLog,
  MailTemplateVersion,
} from './entities/index.js';
import { MailLogService } from './mail-log.service.js';
import { MailTemplateStore } from './mail-template.store.js';
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
  // `TypeOrmModule.forFeature([MailLog])` for the delivery record. The table is
  // the answer to "the user says they got nothing", and it has to be written from
  // the worker that sent the message rather than from the request that asked.
  //
  // The two template tables join it in Phase 22: `EmailTemplate` is the operator's
  // override for a shipped `.hbs` file and `MailTemplateVersion` is what a save
  // replaced. Both are optional in the sense that matters — an empty
  // `email_templates` table renders the shipped files — but the repositories have to
  // exist for the store to ask the question at all.
  imports: [
    ConfigModule.forFeature(mailConfig),
    MetricsModule,
    TypeOrmModule.forFeature([MailLog, EmailTemplate, MailTemplateVersion]),
  ],
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): MailTransport =>
        selectTransport(configService.getOrThrow<MailConfig>('mail')).transport,
    },
    MailService,
    MailLogService,
    // Phase 22. Injected by `MailService`, so every send resolves its template
    // through here rather than through a module-level function — that is what makes
    // an operator's edit take effect without a deploy.
    MailTemplateStore,
  ],
  /**
   * `MAIL_TRANSPORT` is exported because the health indicator asks the transport
   * itself which provider is installed, not only what the service recorded.
   * Naming it here is what lets `HealthModule` import `MailModule` and get it: a
   * module that injects a provider needs the module that provides it in its
   * imports, and a token that is not exported is invisible there.
   */
  exports: [
    MailService,
    MailLogService,
    MAIL_TRANSPORT,
    // Exported for the admin route, which reads and writes templates and would
    // otherwise have to reach into this module's internals.
    MailTemplateStore,
  ],
})
export class MailModule {}
