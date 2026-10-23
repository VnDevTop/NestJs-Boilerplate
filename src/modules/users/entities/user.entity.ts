import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

import { Role } from '../../../common/enums/index.js';
import { DEFAULT_TENANT_ID } from '../../../common/tenancy/tenant.constants.js';

@Entity({ name: 'users' })
@Index('UQ_users_email', ['tenantId', 'email'], { unique: true })
@Index('IDX_users_locked_at', ['tenantId', 'lockedAt'], {
  where: '"lockedAt" IS NOT NULL',
})
// The keyset index behind `GET /users`. Leads with the sort column and carries the
// id as the tie-break, which is what makes a page an index range scan rather than
// a filter over every row sharing a timestamp. Ascending only, because postgres
// scans an index backwards for `?order=asc`.
@Index('IDX_users_createdat_cursor', ['tenantId', 'createdAt', 'id'])
// The GIN index behind the full-text search. A `tsvector` is not a b-tree
// candidate — it holds a document, and the question is which documents contain
// a lexeme — so the index type is the only way to answer it.
@Index('IDX_users_search_vector', ['searchVector'], { type: 'gin' })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
  /**
   * The tenant this row belongs to. Present on every table from the start, so
   * the feature is switchable without a migration — see the constant for why.
   */
  @Column({ type: 'uuid', default: DEFAULT_TENANT_ID })
  tenantId!: string;

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

  /**
   * When the account was locked permanently, or null while it is not.
   *
   * A separate pair of columns rather than a role on `isActive`, because the two
   * mean different things and are cleared by different hands. `isActive` is an
   * administrator's decision and nothing clears it but an administrator. This is
   * set by the application after repeated failed sign-ins and cleared either by an
   * administrator or by whoever controls the confirmed address. Overloading
   * `isActive` would make "an attacker locked this person out" and "support
   * disabled this account" indistinguishable in the audit trail, and would leave
   * the victim no way back in without an operator.
   *
   * Indexed because the question an operator asks most often is "who is locked",
   * and it is asked by filtering this column rather than by reading the table.
   */
  @Column({ type: 'timestamptz', nullable: true })
  lockedAt!: Date | null;

  /**
   * Why the account is locked, in words a person can read.
   *
   * Stored rather than rendered on demand because the reason is decided where the
   * lock happens and the audience is both the operator and the owner, and a
   * message rewritten by a deploy would make an old lock unreadable.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  lockReason!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt!: Date | null;

  /**
   * The searchable text of this account, as one weighted document.
   *
   * **Generated, so it cannot drift.** A column filled by a trigger is a column
   * that can be wrong — the trigger misses, the write is rolled back, the
   * trigger is disabled for a moment — and a search index that is wrong is
   * worse than no index, because it answers "no such user" for a user that
   * exists. A generated column is computed by postgres on every write, so it is
   * the row's own text by construction.
   *
   * **The weights are in the document.** `setweight` marks each field's lexemes
   * with a band, and `ts_rank` reads the bands, so a match on the address
   * outranks a match on the name. The bands come from the field map in
   * `users-search.ts`, and a spec compares the expression here with the one in
   * the migration — a weight that changed in one place and not the other would
   * make the ranking quietly wrong.
   *
   * **Not selected.** The column is large and nothing reads it except the
   * search, which names it in a `WHERE` clause rather than in the select list.
   */
  @Column({
    type: 'tsvector',
    asExpression:
      `setweight(to_tsvector('simple', coalesce("email", '')), 'A') || ` +
      `setweight(to_tsvector('simple', coalesce("firstName", '')), 'B') || ` +
      `setweight(to_tsvector('simple', coalesce("lastName", '')), 'B') || ` +
      `setweight(to_tsvector('simple', coalesce("role", '')), 'C')`,
    generatedType: 'STORED',
    insert: false,
    update: false,
    select: false,
  })
  searchVector!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  /**
   * The optimistic lock counter.
   *
   * `sessionsVersion` answers "are my sessions still alive"; this answers "is the
   * row I read still the row I am writing to". They are unrelated and both are
   * counters, which is exactly why the distinction is worth stating.
   *
   * **The failure it prevents is a lost update.** Two administrators open the same
   * profile. The first saves a role change; the second saves a name change from a
   * form it loaded before that, and — with no version — overwrites the role back.
   * Neither sees anything wrong: both get a 200, and the last write wins silently.
   * With it, the second save affects zero rows and TypeORM raises
   * `OptimisticLockVersionMismatchError`, which `UsersService` turns into a 409.
   *
   * **Optimistic, not pessimistic.** No row lock is taken, so two readers never
   * block each other; the conflict is detected at the write. That is the right shape
   * for a profile edit — the window between read and write is a person's form being
   * filled in, which is seconds, and holding a lock across it would serialise every
   * editor of every row behind whoever opened theirs first.
   *
   * Picked up automatically by `repository.save()`, so the places that already save
   * a `User` are covered without being changed. Query-builder writes
   * (`repository.update`, `.increment`) bypass it, which is why `lockAccount` uses
   * `save` and not `increment`.
   */
  @VersionColumn({ type: 'integer', default: 1 })
  version!: number;

  /**
   * Why this account was erased, in the words the request was made with.
   *
   * Stored rather than derived, because the answer to "why is this row gone" after
   * it is gone is the only thing left. The alternative is inferring it from
   * `deletedAt` and the actor on an audit entry, which is a join across a table
   * that intentionally outlives this one and a guess on top of that.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  deletionReason!: string | null;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  /**
   * Marks the account as erased, starting the clock on the hard delete.
   *
   * **The rule lives on the row, not in a service.** "An erasure request soft
   * deletes and records why" is a statement about what an erasure *is* — it is what
   * makes `deletedAt` mean "somebody asked for this" rather than "an operator
   * archived it", and that distinction is what Phase 16's retention job acts on
   * thirty days later. A service method that did the same three writes would let
   * somebody soft-delete with `repository.softDelete()` and get a row the
   * retention job treats identically but nobody can explain.
   *
   * Sets `deletedAt` itself rather than taking it, so the timestamp is the moment
   * the request was made and not a value a caller can pass. That timestamp is what
   * the thirty-day clock is measured from, and a caller who could set it could ask
   * for deletion and skip the grace period by backdating it.
   */
  requestDeletion(reason: string): void {
    this.deletedAt = new Date();

    // Trimmed because the reason goes in an email to whoever asks about it later,
    // and a leading space from a form field is not part of what they said. The
    // fallback is spelled out rather than left blank for the same reason.
    const trimmed = reason.trim();

    this.deletionReason = trimmed === '' ? 'no reason given' : trimmed;
  }
}
