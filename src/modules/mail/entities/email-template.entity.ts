import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { DEFAULT_TENANT_ID } from '../../../common/tenancy/tenant.constants.js';

/**
 * An editable override for one of the shipped mail templates.
 *
 * ## The row is an override, not the definition
 *
 * A row here replaces the matching `.hbs` file and nothing else. With the table
 * empty the application renders the files exactly as it did in Phase 14, which is
 * what makes this phase additive: an operator who never touches the admin route gets
 * the behaviour they had before, and the files stay the reviewable record of what
 * ships.
 *
 * ## Why a version column and not an append-only history
 *
 * The plan asked for version history, and there is a separate `mail_template_versions`
 * table for it. This counter is the number an operator reads back after an edit —
 * "the version you are looking at is the third" — so a support question about which
 * wording went out has an answer that does not require reading a diff of a history
 * table. The history table is the record; this is the pointer.
 */
@Entity({ name: 'email_templates' })
// One row per template per locale, which is also what makes `findOneBy` correct:
// without the unique index two operators saving the same template concurrently would
// produce two rows and the read path would pick one of them arbitrarily.
@Index('UQ_email_templates_name_locale', ['tenantId', 'name', 'locale'], {
  unique: true,
})
@Index('IDX_email_templates_name', ['name'])
export class EmailTemplate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
  /**
   * The tenant this row belongs to. Present on every table from the start, so
   * the feature is switchable without a migration — see the constant for why.
   */
  @Column({ type: 'uuid', default: DEFAULT_TENANT_ID })
  tenantId!: string;

  /**
   * The template this overrides, matching `TemplateName`.
   *
   * Not a foreign key to anything: the key space is the code registry, not a table,
   * so the database cannot enforce it. The service checks it, and an unknown name is
   * a 404 rather than a row nobody renders.
   */
  @Column({ type: 'varchar', length: 64 })
  name!: string;

  /**
   * BCP 47 tag, defaulting to `en`.
   *
   * A column rather than a flag so a French or Vietnamese deployment can override
   * one template without forking it. The application resolves `en` for every send
   * today, which means a row in any other locale is stored and previewable but not
   * yet sent — recorded here because a column that is always constant is either a
   * missing feature or a wrong schema, and this one is the former.
   */
  @Column({ type: 'varchar', length: 16, default: 'en' })
  locale!: string;

  @Column({ type: 'varchar', length: 255 })
  subject!: string;

  /** The plain-text body, without the shell. */
  @Column({ type: 'text' })
  text!: string;

  /** The html body, without the shell, as handlebars source. */
  @Column({ type: 'text' })
  html!: string;

  /** Incremented on every write, so an operator can name the wording they saw. */
  @Column({ type: 'integer', default: 1 })
  version!: number;

  /**
   * Who saved the current version.
   *
   * Null rather than a foreign key, and deliberately denormalised: the same reasoning
   * as `audit_logs`, whose rows must survive the account they describe. An operator
   * who leaves is not a reason to lose the record that they changed a password reset
   * email.
   */
  @Column({ type: 'uuid', nullable: true })
  updatedBy!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
