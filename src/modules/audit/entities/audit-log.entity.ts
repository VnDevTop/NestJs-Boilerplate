import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A snapshot of a row, as stored in `before` and `after`.
 *
 * A named type rather than `Record<string, unknown>` inline, because TypeORM's
 * `QueryDeepPartialEntity` maps an open record to `unknown`, and `unknown` admits
 * a function — so the compiler can no longer tell a stored value from a column
 * default and refuses the whole insert.
 */
export interface AuditSnapshot {
  [key: string]: unknown;
}

/**
 * One privileged action, recorded.
 *
 * **Append-only.** No `updatedAt`, no `deletedAt`, and nothing in the application
 * updates or soft-deletes a row. The only removal is the retention job, and it
 * removes by age — a year, against `RETENTION_AUDIT_LOGS_DAYS`, because an audit
 * trail kept for a month is not an audit trail.
 *
 * There is no application-level guard against that here, and that is a real
 * limitation rather than an oversight: nothing inside the application can prevent
 * an operator with SQL from rewriting history. What this design does buy is that
 * the *application* never rewrites it, so a gap is always something somebody did
 * outside the code rather than something the code did on its own.
 *
 * **The actor is a snapshot, not a join.** `actorId` has no foreign key and
 * `actorEmail` is copied in at write time. Two reasons, both of which are the
 * question "who did this" asked months later: a user is eventually hard-deleted
 * by the retention job, and an audit trail that loses its actor at the same moment
 * the account is erased is not a trail; and an address can be changed, so a join
 * would answer with the address the person has now rather than the one they had
 * when they did it.
 *
 * **No foreign key on `targetId` either**, for the same reason: the target of an
 * audit entry is frequently the thing being erased, and a key would either block
 * the erasure or cascade the evidence away with it.
 *
 * `before` and `after` are jsonb rather than columns because a diff is a shape
 * that changes per entity, and a fixed column set would mean a migration for every
 * field any future entity has. They are nullable because many actions have no
 * before — a create, a sign-in, a denied request.
 */
@Entity({ name: 'audit_logs' })
@Index('IDX_audit_logs_created_at', ['createdAt'])
@Index('IDX_audit_logs_actor', ['actorId'])
@Index('IDX_audit_logs_action', ['action'])
@Index('IDX_audit_logs_target', ['targetType', 'targetId'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Who did it, by user id. Null for a system action — a scheduled job, a
   * retention run — which is why `actorType` exists rather than treating null as
   * one particular answer.
   *
   * Deliberately not a foreign key: see the class comment.
   */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  /**
   * The address the actor had at the time.
   *
   * Null for a system action, and for a request that arrived without a resolvable
   * user — a rejected sign-in has no actor to name, which is why the `action` and
   * the ip are carrying that row rather than the actor.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  actorEmail!: string | null;

  /**
   * `user`, `system` or `anonymous`.
   *
   * Three values rather than a boolean on `actorId`, because "an unauthenticated
   * request tried this" and "a background job did this" are different facts and a
   * reader filtering on a null id cannot tell them apart.
   */
  @Column({ type: 'varchar', length: 20 })
  actorType!: string;

  /**
   * What happened, as `entity.action` — `users.update`, `auth.login`, `user.deleted`.
   *
   * A column and not something buried in the jsonb, because the first question
   * anybody asks this table is "show me every time somebody did X", and that has
   * to be an index rather than a scan over a year of rows.
   */
  @Column({ type: 'varchar', length: 64 })
  action!: string;

  /** What was acted upon, so entries for one object can be read together. */
  @Column({ type: 'varchar', length: 64 })
  targetType!: string;

  /**
   * The target's id, as a string rather than a uuid.
   *
   * A string because not every target is a user row: a session, a device, a
   * permission name. Forcing a uuid here would mean an empty string or a fake one
   * for every non-user target, and the column is indexed together with
   * `targetType`, so the type already says what the id refers to.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  targetId!: string | null;

  /** The state before. Null for a create, a sign-in or a refusal. */
  @Column({ type: 'jsonb', nullable: true })
  before!: AuditSnapshot | null;

  /** The state after. Null for a delete or a refusal. */
  @Column({ type: 'jsonb', nullable: true })
  after!: AuditSnapshot | null;

  /**
   * Which keys differ, so a reader can filter on "anything that touched a role"
   * without diffing every pair of jsonb documents in the table.
   */
  @Column({ type: 'jsonb', nullable: true })
  changedFields!: string[] | null;

  /** Where the request came from. Null for a system action. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  ipAddress!: string | null;

  /** The client, as sent. Capped, because a user agent is attacker-controlled. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent!: string | null;

  /**
   * Correlates this entry with the log lines and the notification rows of the same
   * request, which is the difference between an entry and an investigation.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  requestId!: string | null;

  /**
   * `success` or `failure`.
   *
   * Failures are recorded, and that is the half most systems skip. A permission
   * that was refused is evidence; a permission that was never asked for is not,
   * and the difference is the whole point of keeping the log.
   */
  @Column({ type: 'varchar', length: 20 })
  outcome!: string;

  /** The status the request returned, on a failure or on a success worth reading. */
  @Column({ type: 'integer', nullable: true })
  statusCode!: number | null;

  /**
   * Why, when the action failed and the reason is not derivable from the status.
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  error!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
