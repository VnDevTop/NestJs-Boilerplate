import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { DEFAULT_TENANT_ID } from '../../../common/tenancy/tenant.constants.js';

/**
 * One attempt to send one mail.
 *
 * **This is the answer to "the user says they got nothing".** Every other place
 * in the application that knows about a send — the log line, the provider call —
 * is gone by the time anybody asks. This row is not: it records what was sent,
 * to whom, through which transport, what the provider answered, and which
 * request asked for it.
 *
 * **One row per attempt, not per send.** A send is retried and each attempt is a
 * separate answer from a separate provider response. Collapsing them means keeping
 * the last status and losing the sequence, and the sequence is what separates
 * "the network is flaky" from "the credential expired four attempts ago".
 *
 * ## The request id is the whole point of the index on it
 *
 * A user reports "I asked for a reset at 14:02 and nothing arrived". The
 * `requestId` from that request turns that into one indexed lookup, and it is the
 * same id on the log lines, on the audit entries and — with Phase 20's tracing —
 * on the spans. Without it the only way to find a send is to search by recipient
 * and guess at a time window.
 *
 * Nullable, because a send does not always come from a request: the retention job
 * and a scheduled digest do not have one.
 *
 * ## The recipient is personal data, and the table outlives the process
 *
 * An operator mailbox, or a person's own address, kept for
 * `RETENTION_MAIL_LOGS_DAYS`. That window is a data-retention decision rather than
 * a housekeeping one, which is why it is the one this table's retention rule is
 * named after.
 *
 * No foreign key to `users`: the rows are evidence, and evidence has to outlive
 * the thing it is evidence about — a cascade would delete the record of a
 * delivery at the moment an operator erased the account it was delivered to.
 */
@Entity({ name: 'mail_logs' })
@Index('IDX_mail_logs_created_at', ['createdAt'])
@Index('IDX_mail_logs_request_id', ['requestId'])
@Index('IDX_mail_logs_recipient', ['to'])
export class MailLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
  /**
   * The tenant this row belongs to. Present on every table from the start, so
   * the feature is switchable without a migration — see the constant for why.
   */
  @Column({ type: 'uuid', default: DEFAULT_TENANT_ID })
  tenantId!: string;

  /**
   * The correlation id carried on the log line, the provider call and this row.
   *
   * Not unique: a retry is a second attempt at the same message, and the attempts
   * are the part worth keeping apart.
   */
  @Index()
  @Column({ type: 'varchar', length: 64 })
  mailId!: string;

  @Column({ type: 'varchar', length: 64 })
  template!: string;

  /** Who it was for. An operator mailbox or a person's own address. */
  @Column({ type: 'varchar', length: 255 })
  to!: string;

  @Column({ type: 'varchar', length: 20 })
  transport!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  subject!: string | null;

  @Column({ type: 'boolean', default: false })
  delivered!: boolean;

  /** The provider's status code, when the attempt got far enough to have one. */
  @Column({ type: 'integer', nullable: true })
  statusCode!: number | null;

  @Column({ type: 'integer', default: 1 })
  attempts!: number;

  /**
   * True when a retry would be refused the same way, so the row explains why the
   * retry budget was not spent on it.
   */
  @Column({ type: 'boolean', default: false })
  permanent!: boolean;

  /** The message rather than a stack trace, for the same reason the notification log does. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  error!: string | null;

  /**
   * The request that caused this send, when there was one.
   *
   * Indexed because it is the lookup somebody does when a user says they got
   * nothing: one query instead of a recipient search and a guessed time window.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  requestId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
