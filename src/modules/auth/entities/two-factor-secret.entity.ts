import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/index.js';
import { DEFAULT_TENANT_ID } from '../../../common/tenancy/tenant.constants.js';

@Entity({ name: 'two_factor_secrets' })
export class TwoFactorSecret {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
  /**
   * The tenant this row belongs to. Present on every table from the start, so
   * the feature is switchable without a migration — see the constant for why.
   */
  @Column({ type: 'uuid', default: DEFAULT_TENANT_ID })
  tenantId!: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  userId!: string;

  /**
   * Declared so the foreign key exists in the schema.
   *
   * The column was there without a relation, so `migration:generate` produced no
   * constraint at all: hard-deleting a user left the secret behind forever, which
   * is precisely the row Phase 16 exists to remove. Cascading means the retention
   * delete needs no second statement and no remembered ordering.
   */
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  /**
   * The TOTP shared secret is never stored in the clear. The three parts come
   * from AES-256-GCM and are split so a database dump cannot be decrypted
   * without TWO_FACTOR_ENCRYPTION_KEY.
   */
  @Column({ type: 'text' })
  secretCiphertext!: string;

  @Column({ type: 'text' })
  secretIv!: string;

  @Column({ type: 'text' })
  secretAuthTag!: string;

  /**
   * Salted hashes of the recovery codes. A spent code is removed from the
   * array, so the list doubles as the set of codes still usable.
   */
  @Column({ type: 'text', array: true, default: '{}' })
  recoveryCodes!: string[];

  @Column({ type: 'boolean', default: false })
  isEnabled!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  enabledAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  /**
   * Counter of the last accepted TOTP step. A code that is older than this is a
   * replay, so the same code cannot be used twice inside its 30 second window.
   */
  @Column({ type: 'integer', nullable: true })
  lastUsedCounter!: number | null;

  @Column({ type: 'integer', default: 0 })
  failedAttempts!: number;

  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
