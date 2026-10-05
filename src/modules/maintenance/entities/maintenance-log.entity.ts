import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { RetentionTrigger } from './retention-trigger.enum.js';
import type { RetentionTargetResult } from '../retention.service.js';

/**
 * One retention run, recorded permanently.
 *
 * Append-only. There is no `updatedAt`, no `deletedAt`, and nothing in the
 * application updates or removes a row: the only write is the insert at the end
 * of a run. That is the point of the table. A log that can be rewritten is not
 * evidence that the cleanup ran, and the whole reason to keep a year of these is
 * so that "the table grew again" can be answered by reading what happened rather
 * than by guessing from a chart.
 *
 * Sized against the real payload: a run with five targets serialises to about
 * 1.2 KB of JSON and 728 bytes stored, so a daily run costs roughly 260 KB a
 * year, and even ten manual runs a day on top of the cron stays under 3 MB.
 * The entire history fits in memory, which is why it carries no index. An index
 * on `startedAt` would be the only index on the table and would cost more than
 * it saves at that size.
 *
 * The trade is deliberate and worth restating: nothing prunes this table. The
 * operator trims it by hand, quarterly or yearly, when the number of rows
 * finally matters.
 */
@Entity({ name: 'maintenance_logs' })
export class MaintenanceLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'timestamptz' })
  startedAt!: Date;

  @Column({ type: 'timestamptz' })
  finishedAt!: Date;

  @Column({ type: 'integer' })
  durationMs!: number;

  @Column({ type: 'boolean' })
  dryRun!: boolean;

  @Column({ type: 'integer', default: 0 })
  totalDeleted!: number;

  /**
   * True when the run stopped on its timeout. Kept as its own column rather than
   * left inside the detail blob because it is the field an operator reads first:
   * a timed-out run means the tables it never reached are still unclean.
   */
  @Column({ type: 'boolean', default: false })
  timedOut!: boolean;

  @Column({ type: 'varchar', length: 20, default: RetentionTrigger.Cron })
  trigger!: RetentionTrigger;

  /** Targets that never ran because the run stopped early. */
  // Declared as a plain literal, not a callback returning the cast. TypeORM
  // appends the column type to a string default when it normalises one, so a
  // callback returning an already-cast string compares unequal to what the
  // driver reads back and every `migration:generate` reports phantom drift on
  // this column. This spelling is the one that matches.
  @Column({ type: 'jsonb', default: '[]' })
  pending!: string[];

  /** Targets that raised an error. Empty on a clean run. */
  @Column({ type: 'jsonb', default: '[]' })
  failedTargets!: string[];

  /**
   * The full run result, per target: rows deleted, batches, duration and the
   * database message if it failed. Deliberately denormalised rather than split
   * into a child table, because a run is only ever read whole, and one insert
   * per run cannot half-succeed the way two inserts can.
   */
  @Column({ type: 'jsonb' })
  targets!: RetentionTargetResult[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
