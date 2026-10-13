import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MetricsService } from '../../core/metrics/index.js';
import type { AppConfig } from '../../configs/app.config.js';
import type { MailConfig } from '../../configs/mail.config.js';
import {
  renderTemplate,
  type TemplateDataByName,
  type TemplateName,
} from './templates/template.registry.js';
import { MemoryMailTransport } from './transports/memory.transport.js';
import { SendgridMailTransport } from './transports/sendgrid.transport.js';
import { SesMailTransport } from './transports/ses.transport.js';
import { SmtpMailTransport } from './transports/smtp.transport.js';
import {
  extractStatusCode,
  isPermanentRejection,
  type MailAttachment,
  type MailMessage,
  type MailTransport,
  type SendResult,
} from './transports/transport.interface.js';

const logger = new Logger('MailService');

/** Injection token for the transport the module selected. */
export const MAIL_TRANSPORT = 'MAIL_TRANSPORT';

/** Result handed back to the caller, carrying the id used in every log line. */
export interface SendMailResult extends SendResult {
  mailId: string;
  template: TemplateName;
  /**
   * Which transport actually ran, and the rendered subject.
   *
   * On the result rather than looked up by the caller, because `mail_logs` is
   * written by the processor and the processor only has this object. Asking the
   * service separately would mean a second source of truth for a fact already
   * known here — and a log row that says "smtp" while the transport was SES.
   */
  transportName: string;
  subject: string;
  /** False when the send failed or the transport was unavailable. */
  delivered: boolean;
  /**
   * Set when `delivered` is false. True means the provider refused the request
   * itself, so another attempt would be refused the same way.
   *
   * The processor needs this to decide whether to retry, and `deliver` is the
   * only place that still has the error. Without it every failure looks
   * transient and a 4xx burns the whole retry budget.
   */
  permanent?: boolean;
  /** The provider's status code, when the error carried one. */
  status?: number;
  /** The failure message, for the log line and the dead-letter entry. */
  error?: string;
}

export interface SendTemplateOptions {
  subjectPrefix?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  attachments?: MailAttachment[];
}

/**
 * Sends transactional mail through whichever transport is configured.
 *
 * The service owns three decisions and nothing else: which transport, how a
 * message is addressed, and what happens when delivery fails. Which bytes leave
 * the process is the transport's business, and how a template becomes a body is
 * the registry's.
 */
@Injectable()
export class MailService {
  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    private readonly metrics: MetricsService,
    private readonly configService: ConfigService,
  ) {}

  private get mailConfig(): MailConfig {
    return this.configService.getOrThrow<MailConfig>('mail');
  }

  private get appConfig(): AppConfig {
    return this.configService.getOrThrow<AppConfig>('app');
  }

  /** The active transport name, for the health check. */
  get transportName(): string {
    return this.transport.name;
  }

  /**
   * Renders a template and sends it.
   *
   * `TName` ties the payload to the template, so passing welcome data to
   * `verify-email` does not compile. The return carries the mail id, which is
   * what makes a delivery traceable from the log to a provider id.
   */
  async sendTemplate<TName extends TemplateName>(
    to: string,
    name: TName,
    data: TemplateDataByName[TName],
    options: SendTemplateOptions = {},
  ): Promise<SendMailResult> {
    const rendered = renderTemplate(name, data);
    const { subjectPrefix } = this.mailConfig;
    const prefix = options.subjectPrefix ?? subjectPrefix;

    const mailId = this.newMailId(name);

    const message: MailMessage = {
      to,
      subject: prefix ? `[${prefix}] ${rendered.subject}` : rendered.subject,
      text: rendered.text,
      html: rendered.html,
      from: this.mailConfig.from,
      replyTo: options.replyTo ?? this.mailConfig.replyTo,
      cc: options.cc,
      bcc: options.bcc,
      attachments: options.attachments,
      mailId,
      template: name,
    };

    return this.deliver(message, name);
  }

  /**
   * Sends an already-built message.
   *
   * The catch is the point of this method: a provider outage is an operational
   * problem, and turning it into a 500 on register or login would make an
   * unrelated feature look broken. The caller gets `delivered: false` and the id,
   * and the error is in the log.
   */
  private async deliver(
    message: MailMessage,
    template: TemplateName,
  ): Promise<SendMailResult> {
    try {
      const result = await this.transport.send(message);

      logger.log(
        `[mail:${message.mailId}] template=${template} ` +
          `transport=${this.transport.name} accepted=${result.accepted.length} ` +
          `rejected=${result.rejected.length}`,
      );

      // Counted on the way out rather than where the job was enqueued, because
      // "enqueued" is not a number anybody can alert on — a provider that refuses
      // everything produces a healthy-looking send count forever.
      this.metrics.mailSent(template, this.transport.name);

      return {
        ...result,
        mailId: message.mailId,
        template,
        transportName: this.transport.name,
        subject: message.subject,
        delivered: true,
      };
    } catch (error) {
      logger.error(
        `[mail:${message.mailId}] template=${template} transport=${this.transport.name} ` +
          `failed: ${error instanceof Error ? error.message : String(error)}`,
      );

      this.metrics.mailFailed(
        template,
        this.transport.name,
        isPermanentRejection(error),
      );

      return {
        accepted: [],
        rejected: [],
        mailId: message.mailId,
        template,
        transportName: this.transport.name,
        subject: message.subject,
        delivered: false,
        permanent: isPermanentRejection(error),
        // Undefined rather than null when there is no status, so the field is
        // simply absent from a network failure.
        status: extractStatusCode(error) ?? undefined,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Sends an operator alert, reusing the `notification` template.
   *
   * The events in Phase 18 are not transactional mail: they have no per-event
   * subject, no link and no recipient-specific wording. Rather than six more
   * registry entries each carrying one pre-rendered string — six more chances to
   * mail a credential to the wrong address — they share one template that takes a
   * headline and a body.
   *
   * `appName` comes from the app config rather than the caller, because the
   * notification module has no reason to know it and a template that takes it as an
   * argument is a template somebody will pass wrong.
   *
   * Returns the same shape as `sendTemplate` rather than throwing, so the caller
   * records the failure the way it records a webhook failure.
   */
  async sendNotification(
    to: string,
    headline: string,
    body: string,
  ): Promise<SendMailResult> {
    return this.sendTemplate(to, 'notification', {
      headline,
      body,
      appName: this.appConfig.name,
    });
  }

  /**
   * `<template>-<uuid>`, so a log line names the template without a second
   * lookup, and the uuid keeps two sends of the same template distinguishable.
   */
  private newMailId(template: TemplateName): string {
    return `${template}-${randomUUID()}`;
  }

  /**
   * Builds a link back to this deployment, for a template that needs one.
   *
   * The trailing slash is stripped here rather than trusted from the app config,
   * because this is the function that puts a token in a url: a double slash is
   * the difference between a working verification link and a dead one, and
   * depending on another module's normalisation for that is a thin margin.
   */
  buildUrl(path: string): string {
    const base = this.appConfig.url.replace(/\/+$/, '');

    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  }
}

/**
 * Chooses the transport named by configuration.
 *
 * A provider whose package is not installed falls back to the memory transport
 * rather than throwing, so the app boots and a feature nobody enabled costs
 * nothing. Production validation already refuses `memory`, so a deploy that
 * reaches this with a missing package has a misconfiguration worth a loud log
 * rather than a crash at the first email.
 */
export function selectTransport(config: MailConfig): {
  transport: MailTransport;
  fellBack: boolean;
} {
  switch (config.transport) {
    case 'smtp': {
      const smtp = new SmtpMailTransport(config);

      if (smtp.isAvailable()) {
        return { transport: smtp, fellBack: false };
      }

      break;
    }

    case 'ses': {
      const ses = new SesMailTransport(config);

      if (ses.isAvailable()) {
        return { transport: ses, fellBack: false };
      }

      break;
    }

    case 'sendgrid': {
      const sendgrid = new SendgridMailTransport(config);

      if (sendgrid.isAvailable()) {
        return { transport: sendgrid, fellBack: false };
      }

      break;
    }

    case 'memory':
      break;
  }

  const transport = new MemoryMailTransport();

  if (config.transport !== 'memory') {
    logger.error(
      `MAIL_TRANSPORT is "${config.transport}" but its package is not installed, ` +
        'so nothing will be delivered. See docs/optional-integrations.md for the ' +
        'install command, or set MAIL_TRANSPORT=memory in development.',
    );
  }

  return { transport, fellBack: config.transport !== 'memory' };
}
