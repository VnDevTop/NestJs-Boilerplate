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

import { Permission } from './permission.entity.js';

/**
 * Grants one permission to one role.
 *
 * A join table rather than a list on the role, because a role is a `varchar` on
 * `users` and there is no role row to hang a list off. That also means adding a
 * role is a data change rather than a migration, and this table is what gives the
 * role its meaning.
 *
 * The unique index on the pair is the whole point of the table: without it a
 * double seed or a retry inserts the same grant twice, and a permission count
 * that includes a duplicate is a number nobody can trust when debugging why a
 * guard let someone through.
 *
 * Cascades on both foreign keys. A permission removed from the catalog takes its
 * grants with it, and a grant row cannot outlive the permission it names.
 */
@Entity({ name: 'role_permissions' })
@Index('IDX_role_permissions_role_permission', ['role', 'permissionId'], {
  unique: true,
})
export class RolePermission {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 50 })
  role!: string;

  @Column({ type: 'uuid' })
  permissionId!: string;

  /**
   * The grant's other side, read rather than resolved by hand.
   *
   * Cascades so deleting a permission removes its grants. That is the one write
   * that reaches this table outside a seed, and without the cascade it would
   * fail on a foreign key and leave the permission undeletable.
   */
  @ManyToOne(() => Permission, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'permissionId' })
  permission!: Permission;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
