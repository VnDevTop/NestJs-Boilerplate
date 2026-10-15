import type { DataSource, Repository } from 'typeorm';

import { EmailTemplate } from '../../modules/mail/entities/email-template.entity.js';
import { loadShippedTemplate } from '../../modules/mail/templates/shipped-templates.js';
import {
  TEMPLATE_NAMES,
  type TemplateName,
} from '../../modules/mail/templates/template.registry.js';
import type { Seeder } from './admin.seeder.js';

/**
 * Loads every shipped template into `email_templates`.
 *
 * ## Why the table is seeded at all, when an empty one already works
 *
 * An empty table is a supported state — the store falls back to the shipped files, so
 * a deployment that never runs this seeder behaves exactly as it did before Phase 22.
 * The seeder exists for the *operator*: a row is what the admin route edits, what the
 * version history compares, and what a reviewer can see in a database rather than
 * inferring from the filesystem.
 *
 * ## It inserts, and never overwrites
 *
 * The second run of a seeder must not undo an operator's work. A template that
 * exists is left exactly as it is, which means a `.hbs` fix shipped in a later
 * release does **not** reach a template somebody has already edited. That is the
 * intended trade: silently overwriting an edit made deliberately is the one outcome
 * an operator would not forgive, and a fresh clone has no rows so it always gets the
 * files. Resetting one template to the shipped wording is the admin route's job, and
 * it is explicit.
 *
 * The count it reports is therefore the number of templates that were *not* already
 * present, which is the only number that says anything.
 */
export class MailTemplateSeeder implements Seeder {
  readonly name = 'mail-templates';

  async run(dataSource: DataSource): Promise<void> {
    const templates = dataSource.getRepository(EmailTemplate);

    let inserted = 0;

    for (const name of TEMPLATE_NAMES) {
      const shipped = loadShippedTemplate(name);

      // A name in the registry with no file is a packaging fault — the assets were not
      // copied into the build — and silently skipping it would leave a template that
      // fails at the first send instead of at the seed.
      if (!shipped) {
        throw new Error(
          `The registry lists the ${name} template but no .hbs file shipped with it. ` +
            'Check the "assets" entry in nest-cli.json.',
        );
      }

      inserted += await this.insertIfAbsent(templates, name, shipped);
    }

    process.stdout.write(
      `  mail templates: ${inserted} of ${TEMPLATE_NAMES.length} added, the rest were already stored\n`,
    );
  }

  /**
   * One insert, or nothing.
   *
   * `ON CONFLICT DO NOTHING` rather than a read-then-write: two `npm run seed` in
   * parallel would both read "absent" and both insert, and the unique index would
   * turn the loser into an error rather than a duplicate. The `orIgnore()` keeps the
   * count honest, which is what makes the printed line worth reading.
   */
  private async insertIfAbsent(
    repository: Repository<EmailTemplate>,
    name: TemplateName,
    shipped: { subject: string; text: string; html: string },
  ): Promise<number> {
    const result = await repository
      .createQueryBuilder()
      .insert()
      .into(EmailTemplate)
      .values({ name, locale: 'en', ...shipped, version: 1, updatedBy: null })
      .orIgnore()
      .returning('id')
      .execute();

    return result.raw.length;
  }
}
