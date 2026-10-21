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
 * A single-use password reset token.
 *
 * Hashed with sha256, like the verification token, and for the same reason: the
 * plaintext exists only inside the email that carries it, so a table read cannot
 * produce a working token.
 *
 * The row is what makes the token single use. Consuming it sets `usedAt` inside
 * the same transaction that changes the password, so a crash can never leave a
 * live token next to a changed password.
 */
@Entity({ name: 'password_reset_tokens' })
@Index('UQ_password_reset_tokens_token', ['tenantId', 'tokenHash'], {
  unique: true,
})
@Index('IDX_password_reset_tokens_user', ['userId'])
export class PasswordResetToken {
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

  /** Hex sha256 of the token, 64 characters. */
  @Column({ type: 'varchar', length: 64 })
  tokenHash!: string;

  /**
   * When the token stops being accepted. Indexed, because Phase 16 deletes on
   * this column.
   */
  @Index()
  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  /**
   * Set the moment the password is changed.
   *
   * Null means usable. The lookup is therefore `usedAt IS NULL AND expiresAt >
   * now`, which is the condition the repository filters on rather than a
   * separate boolean that could disagree with the timestamp.
   */
  @Column({ type: 'timestamptz', nullable: true })
  usedAt!: Date | null;

  /**
   * Where the request came from, shown in the email so a user can tell their own
   * request from a stranger's.
   */
  @Column({ type: 'varchar', length: 100, nullable: true })
  ipAddress!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
