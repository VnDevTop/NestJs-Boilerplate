import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * A superseded version of an `email_templates` row.
 *
 * ## Why this is a table and not a git revert
 *
 * "What did the password reset email say last Tuesday?" is the question this table
 * answers, and it is asked by somebody who has no deploy and no repository — an
 * operator, or whoever gets the ticket. A revert through the application is the
 * answer to a different question, and by the time somebody wants the old wording the
 * only place it existed is a commit hash.
 *
 * ## One row per save, not per diff
 *
 * Each row is the complete template as it was immediately before a save. A row per
 * changed line would make reconstructing a version a second query and would produce
 * rows nobody can read; a row per save is the whole thing, which is what the
 * question actually asks for.
 *
 * ## Purged by Phase 16
 *
 * `mail_template_versions` is a retention target. Without a purge this is the only
 * table in the schema that grows without bound and is never read in a loop.
 */
@Entity({ name: 'mail_template_versions' })
// The read is "the versions of this template, newest first", which is the composite
// key: template identity plus a monotonic ordering within it.
@Index('IDX_mail_template_versions_template', ['name', 'locale', 'version'])
@Index('IDX_mail_template_versions_created_at', ['createdAt'])
export class MailTemplateVersion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  name!: string;

  @Column({ type: 'varchar', length: 16 })
  locale!: string;

  /** The version number being replaced, so a restore knows what it is restoring. */
  @Column({ type: 'integer' })
  version!: number;

  @Column({ type: 'varchar', length: 255 })
  subject!: string;

  @Column({ type: 'text' })
  text!: string;

  @Column({ type: 'text' })
  html!: string;

  /** Who saved the version this row preserves. */
  @Column({ type: 'uuid', nullable: true })
  updatedBy!: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
