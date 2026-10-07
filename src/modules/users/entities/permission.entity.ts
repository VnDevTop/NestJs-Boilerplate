import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A named thing an authorised actor is allowed to do.
 *
 * Rows rather than a hard-coded enum, because a permission is a thing an operator
 * eventually has to attach to a role from an admin screen, and an enum makes that
 * a deploy. The `name` is the contract the code checks against, so it is the one
 * column that must never change meaning: renaming a row silently breaks every
 * guard that referenced it.
 *
 * The canonical names live in `src/common/enums/permission.enum.ts` so a typo in
 * a decorator is a compile error rather than a route nobody can reach.
 */
@Entity({ name: 'permissions' })
export class Permission {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 100 })
  name!: string;

  /** What holding this permission is for, read by whoever edits roles. */
  @Column({ type: 'varchar', length: 255, default: '' })
  description!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
