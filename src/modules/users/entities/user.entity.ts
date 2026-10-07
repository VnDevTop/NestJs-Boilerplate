import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Role } from '../../../common/enums/index.js';

@Entity({ name: 'users' })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255 })
  email!: string;

  @Column({ type: 'varchar', length: 255 })
  password!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  firstName!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  lastName!: string | null;

  @Column({
    type: 'varchar',
    length: 50,
    default: Role.User,
  })
  role!: Role;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'boolean', default: false })
  isManager!: boolean;

  /**
   * Bumped whenever every session should die at once.
   *
   * Access tokens are stateless, so revoking them normally means waiting for
   * `exp`. This number goes into every access token as a claim, and the strategy
   * compares it against this column, which turns "log out everywhere" into an
   * immediate event instead of a fifteen minute wait.
   *
   * Incremented, never set to a fixed value, so a user who logs out twice gets two
   * different versions and a token minted between the two cannot be confused with
   * one minted before the first.
   *
   * Zero means "has never been revoked", which is what lets a token issued before
   * this column existed stay valid: it carries no claim, and a user at zero has
   * nothing to have been revoked from.
   */
  @Column({ type: 'integer', default: 0 })
  sessionsVersion!: number;

  /**
   * Whether the address in `email` has been confirmed.
   *
   * A row of its own rather than "is there a live verification token", because
   * the token is deleted on confirmation and on retention while this is the
   * lasting answer. Phase 19 uses it to gate sensitive actions.
   */
  @Column({ type: 'boolean', default: false })
  isEmailVerified!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  emailVerifiedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
