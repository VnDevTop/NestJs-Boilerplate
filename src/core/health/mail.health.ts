import { Inject, Injectable, Logger } from '@nestjs/common';
import type { HealthIndicatorResult } from '@nestjs/terminus';

import { MAIL_TRANSPORT, MailService } from '../../modules/mail/index.js';
import type { MailTransport } from '../../modules/mail/transports/transport.interface.js';

/**
 * Reports which mail transport is active, and whether it is usable.
 *
 * **It reports `degraded`, never `down`.** A registration that cannot send its
 * verification mail still creates the account and still returns a token — mail
 * failing degrades a signup into one the owner has to finish from their inbox, and
 * a password reset into a wait. It does not take the application down. Reporting
 * `down` would have Terminus throw 503, an orchestrator would pull every instance
 * out of rotation, and a mail provider outage would become an outage of a system
 * that was still answering requests.
 *
 * ## Why no send is attempted
 *
 * This could prove the transport works by sending something, and deliberately does
 * not. There is no recipient who wants a health-check email, no way to keep a
 * probe address out of a real recipient list, and a provider rate limit would
 * eventually refuse the probe and take the real queue down with it — the health
 * check causing the outage it exists to detect.
 *
 * What it can report honestly is which transport is configured, because the answer
 * to "why did nobody get the mail" is very often "this deployment has no transport
 * at all". A `memory` transport in a production deployment is a real finding, and
 * it is one this check surfaces without needing a network call.
 */
@Injectable()
export class MailHealthIndicator {
  private readonly logger = new Logger(MailHealthIndicator.name);

  constructor(
    private readonly mail: MailService,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {}

  async isHealthy(): Promise<HealthIndicatorResult> {
    const name = this.mail.transportName ?? this.transport.name;

    if (name === 'memory') {
      // Not an error, and not `up` either. The memory transport is the right choice
      // in development and a silent data loss in production: every mail is written
      // to a buffer that dies with the process.
      return {
        mail: {
          status: 'degraded',
          transport: 'memory',
          reason: 'mail is buffered in memory and is not being delivered',
        },
      };
    }

    try {
      if (typeof this.transport.verify !== 'function') {
        // A transport may not implement an active check, which is a gap rather than
        // a failure. Reporting the transport name and saying so beats inventing a
        // probe that sends mail.
        return {
          mail: { status: 'up', transport: name, verified: false },
        };
      }

      const ok = await this.transport.verify();

      return {
        mail: {
          status: ok ? 'up' : 'degraded',
          transport: name,
          reason: ok ? undefined : 'the transport reported itself unusable',
        },
      };
    } catch (error) {
      this.logger.warn(`Mail transport check failed: ${String(error)}`);

      return {
        mail: {
          status: 'degraded',
          transport: name,
          reason: 'the transport could not be reached',
        },
      };
    }
  }
}
