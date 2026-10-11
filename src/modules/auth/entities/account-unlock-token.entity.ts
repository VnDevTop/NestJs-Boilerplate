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

/**
 * A single-use token that clears a permanent lockout.
 *
 * Identical in shape to `EmailVerificationToken` and `PasswordResetToken`, and
 * deliberately so: all three are bearer credentials that prove control of an inbox,
 * all three store only the sha256 of what was sent, and all three are spent by
 * writing to the row so the spend and the effect it authorises happen in one
 * transaction. Three tables rather than one polymorphic table, because a
 * `tokenType` column would put the write that spends a reset token on the same row
 * shape as the write that spends a verification token, and the constraint that
 * keeps them apart would be a string comparison at runtime.
 */
@Entity({ name: 'account_unlock_tokens' })
@Index('IDX_account_unlock_tokens_user', ['userId'])
export class AccountUnlockToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  /** Hex sha256 of the token, 64 characters. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  tokenHash!: string;

  /**
   * When the token stops being accepted.
   *
   * Indexed for the same reason the others are: Phase 16's retention job scans on
   * this column nightly, and an unindexed range scan over a growing table is a cost
   * nobody notices until it is expensive.
   */
  @Index()
  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  /** Set when the lock it clears is cleared, which is what makes it spent. */
  @Column({ type: 'timestamptz', nullable: true })
  usedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
