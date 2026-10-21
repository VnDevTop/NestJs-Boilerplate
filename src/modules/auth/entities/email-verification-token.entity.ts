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
 * A single-use email verification token.
 *
 * Only the sha256 hash of the token is stored. A token is a bearer credential:
 * the value that arrives in the email is the only thing that works, so anyone
 * reading this table must not be able to produce a working token. Hashing also
 * makes the column fixed width, so the lookup is an equality match on an index
 * rather than a scan over variable-length text.
 */
@Entity({ name: 'email_verification_tokens' })
@Index('UQ_email_verification_tokens_token', ['tenantId', 'tokenHash'], {
  unique: true,
})
@Index('IDX_email_verification_tokens_user', ['userId'])
export class EmailVerificationToken {
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
   * The address this token verifies.
   *
   * Denormalised on purpose: a user who changes their address must not be able
   * to confirm the new one with a token minted for the old one. A resend for a
   * different address mints a new row rather than updating this one, so the old
   * row keeps verifying what it was issued for.
   */
  @Column({ type: 'varchar', length: 255 })
  email!: string;

  /**
   * When the token stops being accepted. Indexed, because Phase 16 deletes on
   * this column and an unindexed range scan over a growing table is a nightly
   * cost nobody notices until it is expensive.
   */
  @Index()
  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  /** Set when the address is confirmed, which is what makes the token spent. */
  @Column({ type: 'timestamptz', nullable: true })
  usedAt!: Date | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  ipAddress!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
