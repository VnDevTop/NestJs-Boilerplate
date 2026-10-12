import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { MetricsService } from '../../core/metrics/index.js';
import { NotificationLog } from './entities/index.js';
import type { NotificationLogWriter } from './notification.service.js';
import type { LogEntry } from './types/index.js';

/** Long enough to identify the provider's complaint, short enough to index cheaply. */
const ERROR_LIMIT = 500;
const BODY_LIMIT = 1000;

/**
 * Appends one row per delivery attempt to `notification_logs`.
 *
 * **Every failure to write is swallowed.** The table is evidence, and evidence is
 * worth having right up until the point where collecting it breaks the thing it
 * describes: a notification log insert that throws would turn a delivered webhook
 * into a failed job, which the queue would retry, which would deliver it again. An
 * operator would rather have a missing row than a tripled security alert.
 *
 * Truncation rather than rejection. A provider's error body can be a page of html
 * and the rendered body can be long; the columns are bounded, so a value is cut to
 * fit. Cutting is right for both: the first 500 characters of an error identify the
 * error, and a truncated message still says what the notification was about.
 */
@Injectable()
export class NotificationLogService implements NotificationLogWriter {
  private readonly logger = new Logger(NotificationLogService.name);

  constructor(
    @InjectRepository(NotificationLog)
    private readonly logs: Repository<NotificationLog>,
    private readonly metrics: MetricsService,
  ) {}

  async record(entry: LogEntry): Promise<void> {
    // Counted before the insert, so a row that fails to write does not silently
    // lose the measurement too. The row and the counter answer different
    // questions — "what happened" and "how often" — and only one of them is
    // allowed to be missing.
    this.metrics.notificationSent(entry.event, entry.channel, entry.delivered);

    try {
      await this.logs.insert({
        notificationId: entry.notificationId,
        requestId: entry.requestId ?? null,
        event: entry.event,
        channel: entry.channel,
        userId: entry.userId ?? null,
        recipient: entry.recipient ?? null,
        delivered: entry.delivered,
        statusCode: entry.statusCode ?? null,
        attempts: entry.attempts,
        error: clip(entry.error, ERROR_LIMIT),
        body: clip(entry.body, BODY_LIMIT),
      });
    } catch (error) {
      this.logger.error(
        `Could not record a ${entry.event} notification on ${entry.channel}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Recent deliveries, newest first, for an operator reading what went out. */
  async recent(limit: number): Promise<NotificationLog[]> {
    return this.logs.find({
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /** One notification's attempts across its channels, in order. */
  async forNotification(notificationId: string): Promise<NotificationLog[]> {
    return this.logs.find({
      where: { notificationId },
      order: { createdAt: 'ASC' },
    });
  }
}

/** Cuts to fit, marking that it did. `undefined` stays absent rather than empty. */
function clip(value: string | undefined, limit: number): string | null {
  if (value === undefined) {
    return null;
  }

  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
