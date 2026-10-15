import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { redactText } from '../../core/redact/index.js';

import { MailLog } from './entities/index.js';

/** Long enough to identify the provider's complaint, short enough to index cheaply. */
const ERROR_LIMIT = 500;

/**
 * One row per delivery attempt to `mail_logs`.
 *
 * **This table is the answer to "the user says they got nothing".** Every other
 * place that knows about a send — a log line, the provider's own dashboard — is
 * gone or unreachable by the time anybody asks, and the question arrives as an
 * address and a rough time.
 *
 * ## Every failure to write is swallowed
 *
 * Same reasoning as the notification log, and the same asymmetry: evidence is
 * worth having right up until the point where collecting it breaks the thing it
 * describes. An insert that throws would turn a delivered email into a failed
 * job, which the queue would retry, which would send it again — and a duplicate
 * verification email is a worse outcome than a missing log row.
 *
 * ## Truncation, not rejection
 *
 * A provider's error body can be a page of HTML. The column is bounded, so the
 * value is cut to fit: the first 500 characters identify the error, and a
 * truncated message still says which send it was about.
 */
/**
 * The part of `MailLogService` the queue processor needs.
 *
 * A narrow interface rather than the class, so `QueueModule` does not have to
 * import the mail *repository* to send a mail — and so a test of the processor
 * needs a two-method fake rather than a TypeORM double.
 */
export interface MailLogWriter {
  record(entry: {
    mailId: string;
    template: string;
    to: string;
    transport: string;
    subject?: string | null;
    delivered: boolean;
    statusCode?: number | null;
    attempt: number;
    permanent?: boolean;
    error?: string | null;
    requestId?: string | null;
  }): Promise<void>;
}

@Injectable()
export class MailLogService implements MailLogWriter {
  private readonly logger = new Logger(MailLogService.name);

  constructor(
    @InjectRepository(MailLog)
    private readonly logs: Repository<MailLog>,
  ) {}

  /**
   * Records one attempt.
   *
   * `attempt` rather than `attempts`: each attempt is its own row, which is what
   * distinguishes "the network is flaky" from "the credential expired four
   * attempts ago".
   */
  async record(entry: Parameters<MailLogWriter['record']>[0]): Promise<void> {
    try {
      await this.logs.insert({
        mailId: entry.mailId,
        template: entry.template,
        to: entry.to,
        transport: entry.transport,
        subject: entry.subject ?? null,
        delivered: entry.delivered,
        statusCode: entry.statusCode ?? null,
        attempts: Math.max(1, entry.attempt),
        permanent: entry.permanent ?? false,
        // Redacted before the clip, for the reason given in `audit.service`:
        // clipping first preserves exactly the prefix a token lives in. Provider
        // error bodies quote the request that produced them.
        error: entry.error
          ? redactText(entry.error).slice(0, ERROR_LIMIT)
          : null,
        // Nullable rather than omitted: a send from the retention job or a
        // scheduled digest has no request, and the column has to say so rather
        // than leaving the lookup unable to distinguish "no request" from "old
        // row written before the column existed".
        requestId: entry.requestId ?? null,
      });
    } catch (error) {
      this.logger.warn(
        `Could not record the send of ${entry.template} to ${entry.to}: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          'The message was not affected.',
      );
    }
  }

  /**
   * Everything sent for one request.
   *
   * The lookup the `requestId` index exists for, exposed so the runbook's
   * "trace a missing email" section is a query and not a description of one.
   */
  async forRequest(requestId: string, limit = 50): Promise<MailLog[]> {
    return this.logs.find({
      where: { requestId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }
}
