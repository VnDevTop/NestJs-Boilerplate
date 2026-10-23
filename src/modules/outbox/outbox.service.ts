import { Injectable, Logger } from '@nestjs/common';
import { QueryRunner, Repository } from 'typeorm';
import { DataSource } from 'typeorm';

import { Outbox } from './outbox.entity.js';

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Save an event to the outbox in the same transaction as the state change.
   *
   * @param queryRunner The query runner from the requesting transaction
   * @param aggregate The aggregate root that triggered the event
   * @param eventId The unique event ID
   * @param payload The event payload
   */
  async saveEvent(
    queryRunner: QueryRunner,
    aggregate: string,
    eventId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const repository: Repository<Outbox> = this.dataSource.getRepository(
      Outbox,
      'master',
    );

    const event = new Outbox();
    event.id = crypto.randomUUID();
    event.aggregate = aggregate;
    event.eventId = eventId;
    event.payload = payload;

    await repository.save(event);

    this.logger.log(
      `Saved event to outbox: aggregate=${aggregate}, eventId=${eventId}`,
    );
  }

  /**
   * Get all unprocessed events from the outbox.
   *
   * @param queryRunner The query runner
   * @returns List of unprocessed events
   */
  async getUnprocessedEvents(queryRunner: QueryRunner): Promise<Outbox[]> {
    const repository: Repository<Outbox> = this.dataSource.getRepository(
      Outbox,
      'master',
    );

    return repository.find({
      where: { processedAt: null },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Mark an event as processed.
   *
   * @param queryRunner The query runner
   * @param eventId The event ID to mark as processed
   */
  async markProcessed(
    queryRunner: QueryRunner,
    eventId: string,
  ): Promise<void> {
    const repository: Repository<Outbox> = this.dataSource.getRepository(
      Outbox,
      'master',
    );

    await repository.update({ eventId }, { processedAt: new Date() });

    this.logger.log(`Marked event as processed: eventId=${eventId}`);
  }
}
