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
import { RefreshTokenRevokedReason } from '../enums/index.js';

@Entity({ name: 'refresh_tokens' })
@Index('IDX_refresh_tokens_user_revoked', ['userId', 'revokedAt'])
// Cursor paging for `GET /auth/sessions`. Replaces nothing — the `(userId,
// revokedAt)` index above still serves the "revoke every session" write path,
// which does not sort.
@Index('IDX_refresh_tokens_user_created_cursor', ['userId', 'createdAt', 'id'])
// The index the session-age check reads.
//
// **Declared on the class, not on the column.** A property-level `@Index` records
// the property alone — TypeORM's decorator drops the column list and keeps
// `[propertyName]` — so the index this declared was `("sessionStartedAt")`,
// while the migration that creates it has always made it
// `("userId", "sessionStartedAt")`. The database was right and the entity was
// wrong, which `synchronize: false` hides until somebody runs
// `migration:generate` and finds a diff that should not exist.
//
// The composite is the one worth having: the question is "which of *this user's*
// sessions have outlived the limit", and an index leading with `userId` seeks
// straight to that user's rows.
@Index('IDX_refresh_tokens_session_started', ['userId', 'sessionStartedAt'])
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  jti!: string;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  /**
   * When this *session* began, carried forward by every rotation.
   *
   * Not the same as `createdAt`, which is the time of this particular token. The
   * two are equal on the first token of a chain and differ on every one after it,
   * which is what makes this column the answer to "how old is this session" and
   * `createdAt` the answer to "when was this token minted".
   */
  @Column({ type: 'timestamptz' })
  sessionStartedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  revokedReason!: RefreshTokenRevokedReason | null;

  @Column({ type: 'uuid', nullable: true })
  replacedById!: string | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  deviceId!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  ipAddress!: string | null;

  @Column({ type: 'text', nullable: true })
  userAgent!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
