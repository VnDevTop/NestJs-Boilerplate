import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { RetentionTrigger } from './retention-trigger.enum.js';
import type { RetentionTargetResult } from '../retention.service.js';
import { DEFAULT_TENANT_ID } from '../../../common/tenancy/tenant.constants.js';

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
 * The entire history fits in memory *today*, which is why it had no index until
 * Phase 23 — but nothing prunes it, so "today" is a statement about the first
 * year of a deployment rather than a property of the table. The history route is
 * cursor paged now, and it carries `(createdAt, id)` for that walk: four kilobytes
 * per thousand rows against a route an operator opens when something has already
 * gone wrong.
 *
 * The trade is deliberate and worth restating: nothing prunes this table. The
 * operator trims it by hand, quarterly or yearly, when the number of rows
 * finally matters.
 */
@Entity({ name: 'maintenance_logs' })
// Phase 23 added this, against the note below that used to say the table carries
// no index. It does now: the history route is cursor paged, and the table grows
// for the life of the deployment because nothing prunes it.
@Index('IDX_maintenance_logs_created_cursor', ['tenantId', 'createdAt', 'id'])
export class MaintenanceLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
  /**
   * The tenant this row belongs to. Present on every table from the start, so
   * the feature is switchable without a migration — see the constant for why.
   */
  @Column({ type: 'uuid', default: DEFAULT_TENANT_ID })
  tenantId!: string;

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

  /**
   * True when the run stopped because somebody asked it to.
   *
   * Its own column for the same reason `timedOut` has one, and because the two
   * mean opposite things: a timed-out run needs attention and a cancelled run
   * was stopped on purpose. Both leave targets unreached, so `pending` alone
   * cannot tell them apart, and a record that cannot tell them apart is a
   * record an operator has to guess at.
   */
  @Column({ type: 'boolean', default: false })
  cancelled!: boolean;

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
