import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/index.js';

@Entity({ name: 'user_devices' })
@Index('IDX_user_devices_user_active', ['userId', 'isActive'])
export class UserDevice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  user!: User;

  @Column({ type: 'varchar', length: 100, nullable: true })
  deviceName!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  ipAddress!: string | null;

  @Column({ type: 'text', nullable: true })
  userAgent!: string | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  /**
   * Bumped when this device signs out, so one session dies without the others.
   *
   * `users.sessionsVersion` is per account: bumping it takes every device out at
   * once, which is right for "log out everywhere" and wrong for signing out of
   * one browser while the phone stays signed in. This column is the same counter
   * narrowed to the machine, read only when an access token names a device.
   *
   * Increment, never set to a fixed value, for the reason the account level one
   * is: a device revoked twice must produce two different numbers, or a token
   * minted between the two cannot be told from one minted before the first.
   *
   * Zero means "never revoked". That is what lets an access token minted before
   * this column existed keep working: it carries no claim, and a device at zero
   * has nothing to have been revoked from.
   */
  @Column({ type: 'integer', default: 0 })
  sessionsVersion!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
