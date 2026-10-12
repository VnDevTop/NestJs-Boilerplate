import { Module, type OnApplicationShutdown } from '@nestjs/common';

import { SentryService } from './sentry.service.js';

/**
 * Error reporting.
 *
 * Imports nothing. The service reaches the SDK through `loadOptional` and needs
 * no other module, so this is a leaf in the graph and can sit at the root without
 * anything having to import it to be able to report.
 *
 * The provider is built once per application, not once per injection site, so the
 * SDK is initialised exactly once — a second `init` discards the first one's
 * configuration, which is the sort of bug that looks like a broken DSN.
 */
@Module({
  providers: [SentryService],
  exports: [SentryService],
})
export class SentryModule implements OnApplicationShutdown {
  constructor(private readonly sentry: SentryService) {}

  /**
   * Flushes before the process exits.
   *
   * Sentry's transport batches, so a process that exits without flushing loses
   * the last few events — which are the ones around the reason it exited. This is
   * on `onApplicationShutdown` rather than `onModuleDestroy` because Nest runs it
   * after the HTTP server has stopped answering, which is when a shutdown error
   * would otherwise have nowhere to go.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.sentry.flush();
  }
}
