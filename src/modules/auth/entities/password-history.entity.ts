import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from '../../users/entities/index.js';
import { DEFAULT_TENANT_ID } from '../../../common/tenancy/tenant.constants.js';

/**
 * One past password, kept so a user cannot cycle between two of them.
 *
 * **Only the hash is stored**, exactly as for every other credential in this
 * codebase — the same `salt:key` scrypt form `hashPassword` produces. A history of
 * plaintext passwords would be the single worst table in the database: it is the
 * user's most reused credentials, in the clear, with no expiry.
 *
 * **Indexed on `(userId, createdAt)`.** Every read is "the last N for this user",
 * and without the timestamp in the index that is a sort over the user's whole
 * history on every password change — which is exactly when a user is least patient.
 *
 * **No `expiresAt`, and that is the point.** The policy keeps the last N by count,
 * so the table is bounded by `PASSWORD_HISTORY_COUNT × user count` rather than by
 * age. A row's only removal is being pushed out by a newer one, which is what makes
 * it impossible to grow without limit.
 *
 * Cascades with the user, unlike `notification_preferences`. A password history is
 * security material and a restored account should not inherit the hashes of
 * passwords an attacker already knows; a mute is neither.
 */
@Entity({ name: 'password_history' })
@Index('IDX_password_history_user_created', ['userId', 'createdAt'])
export class PasswordHistoryEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
  /**
   * The tenant this row belongs to. Present on every table from the start, so
   * the feature is switchable without a migration — see the constant for why.
   */
  @Column({ type: 'uuid', default: DEFAULT_TENANT_ID })
  tenantId!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  /**
   * The scrypt hash, in the `salt:key` form `password.util.ts` writes.
   *
   * 255 characters because that is the width of `users.password`; reusing the
   * column type means a hash that verifies here verifies there, and a mismatch
   * here would be a history that silently never matches.
   */
  @Column({ type: 'varchar', length: 255 })
  passwordHash!: string;

  /**
   * Why this hash is here, because "when a password changed" and "why" answer
   * different questions during an incident.
   *
   * Kept as a short string rather than an enum: the set is open-ended in a way a
   * column enum is not, and an entry written by a future feature should not need a
   * migration to be readable.
   */
  @Column({ type: 'varchar', length: 40 })
  reason!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

/**
 * Why a hash was written.
 *
 * As constants rather than an enum, so a caller passes a literal the type checks
 * against this union and an unknown value is a compile error rather than a row
 * nobody can interpret later.
 */
export const PASSWORD_CHANGE_REASON = {
  /** The account was created with it. */
  Register: 'register',
  /** A reset link was used. */
  Reset: 'reset',
  /** An administrator set it. */
  Admin: 'admin',
} as const;

export type PasswordChangeReason =
  (typeof PASSWORD_CHANGE_REASON)[keyof typeof PASSWORD_CHANGE_REASON];
