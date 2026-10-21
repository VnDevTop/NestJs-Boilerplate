import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { DEFAULT_TENANT_ID } from '../../../common/tenancy/tenant.constants.js';

/**
 * One user's answer to "should this event reach this channel".
 *
 * A row is an opt-out, not an opt-in. The table is empty on a fresh install and
 * stays empty unless somebody deliberately changes something, which is what makes
 * the default right: a user who has never heard of notifications receives them,
 * and a user who does not want their registration announced in a shared ops
 * channel has a way to say so.
 *
 * `enabled` is stored rather than implied by the row's existence so a grant can be
 * written explicitly. The alternative is a row meaning "off" and its absence
 * meaning "on", which makes "turn this back on" indistinguishable from "never set
 * it", and the first thing an operator does with a mute button is press it twice.
 *
 * Unique per (user, event, channel) rather than per (user, event): a user who
 * muted a security event in Slack has not muted it in email, and one row per pair
 * is what lets the two answers disagree.
 *
 * Cascades with the user. A preference belonging to a row that no longer exists is
 * a preference nobody can ever act on again, and it is the kind of row that
 * accumulates quietly until somebody wonders why the table is large.
 */
@Entity({ name: 'notification_preferences' })
@Unique('UQ_notification_preferences_user_event_channel', [
  'userId',
  'event',
  'channel',
])
@Index('IDX_notification_preferences_user', ['userId'])
export class NotificationPreference {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
  /**
   * The tenant this row belongs to. Present on every table from the start, so
   * the feature is switchable without a migration — see the constant for why.
   */
  @Column({ type: 'uuid', default: DEFAULT_TENANT_ID })
  tenantId!: string;

  /**
   * No foreign key on purpose, unlike `role_permissions`.
   *
   * `role_permissions` is reachable from a role that outlives its holders, and a
   * grant with no role is a bug worth blocking. A notification preference is
   * different: the user row is *soft* deleted first and hard deleted by the
   * retention job after thirty days, and a cascade would silently erase a
   * preference at the moment an operator restores the account. The column is
   * plain, so the preference survives the restore and the retention job prunes it
   * on its own age rule instead.
   */
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 64 })
  event!: string;

  @Column({ type: 'varchar', length: 20 })
  channel!: string;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  /**
   * The optimistic lock counter, for the same reason `User` has one.
   *
   * Worth it here because the update path is a read followed by a save: the
   * preferences route loads the user's existing rows and overwrites them, so two
   * settings screens open at once — a phone and a laptop — and the second save
   * silently reverts whatever the first changed.
   *
   * A phone and a laptop is not a rare user, it is the ordinary one, and the window
   * is however long a person takes to change two toggles.
   */
  @VersionColumn({ type: 'integer', default: 1 })
  version!: number;
}
