import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One attempt to deliver one notification on one channel.
 *
 * **Append-only, and written whether the delivery worked or not.** The row that
 * says a Telegram message was refused with a 401 is the row an operator actually
 * needs, and a log that only records successes cannot answer "did it arrive",
 * which is the only question anybody has at 3am.
 *
 * One row per attempt rather than one per notification, because a delivery is
 * retried and each attempt is a separate answer from a separate provider response.
 * Collapsing them would mean keeping the last status and losing the sequence, and
 * the sequence is what distinguishes "flaky network" from "the token expired".
 *
 * `event` and `channel` are columns rather than only a payload blob for the same
 * reason `mail_logs` would be: an operator filters by them constantly and a jsonb
 * scan over a table that grows on every registration is not an answer.
 *
 * Sized against the real payload. A row is about 200 bytes of columns plus a
 * short error string, so even a busy deployment sending four channels per event
 * lands under 10 MB a month, which is what `RETENTION_NOTIFICATION_LOGS_DAYS`
 * bounds.
 *
 * No `updatedAt` and no `deletedAt`: nothing rewrites or soft-deletes a log row.
 * The only removal is the retention job, and it removes by age like everything
 * else it cleans.
 */
@Entity({ name: 'notification_logs' })
@Index('IDX_notification_logs_created_at', ['createdAt'])
@Index('IDX_notification_logs_event', ['event'])
export class NotificationLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  notificationId!: string;

  @Column({ type: 'varchar', length: 64 })
  event!: string;

  @Column({ type: 'varchar', length: 20 })
  channel!: string;

  /**
   * Set when the event belongs to a user. Nullable because the retention anomaly
   * has no user: it is a fact about the deployment rather than about somebody.
   */
  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  /**
   * Where it went, or where it was refused.
   *
   * An address here is a real operator mailbox or a chat id, so this is personal
   * data in a table that outlives the process. It is the reason the retention job
   * exists for this table at all.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  recipient!: string | null;

  @Column({ type: 'boolean', default: false })
  delivered!: boolean;

  /** The provider's status code, when the attempt got far enough to have one. */
  @Column({ type: 'integer', nullable: true })
  statusCode!: number | null;

  @Column({ type: 'integer', default: 1 })
  attempts!: number;

  /**
   * Set on failure. The message rather than a stack trace: a stack trace from a
   * webhook timeout is noise, and the message is what identifies the problem.
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  error!: string | null;

  /**
   * The rendered text as it went out, capped. This is what makes a missed
   * notification reconstructable: the answer to "what did it actually say" is in
   * the row rather than in the template history, which a deploy has already
   * overwritten.
   */
  @Column({ type: 'varchar', length: 1000, nullable: true })
  body!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
