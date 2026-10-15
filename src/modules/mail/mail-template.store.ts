import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import {
  CACHE_NAMESPACE,
  CacheService,
  cacheKey,
} from '../../core/cache/index.js';
import { EmailTemplate } from './entities/email-template.entity.js';
import { MailTemplateVersion } from './entities/mail-template-version.entity.js';
import {
  assertKnownHelpers,
  assertSafeToRender,
  compilePart,
  renderPart,
} from './templates/handlebars.js';
import { loadShippedTemplate } from './templates/shipped-templates.js';
import { sampleData } from './templates/template-fields.js';
import type {
  TemplateDataByName,
  TemplateName,
} from './templates/template.registry.js';
import { layout } from './templates/layout.js';

/** The locale every send resolves today. */
export const DEFAULT_LOCALE = 'en';

/** What a template resolves to, before any data is interpolated. */
export interface ResolvedTemplate {
  subject: string;
  text: string;
  html: string;
  /** Where it came from. Reported by the admin route so an operator can tell. */
  origin: 'database' | 'file';
  version: number | null;
}

/**
 * The cache key for one template's source.
 *
 * The locale is part of the key rather than part of the value because a future
 * deployment resolving a second locale must not be served the `en` row, and because
 * it makes the key self-describing in a `KEYS` scan when somebody is trying to work
 * out why an edit did not take effect.
 */
export const mailTemplateKey = (name: TemplateName, locale: string): string =>
  cacheKey(CACHE_NAMESPACE.Mail, name, locale);

/**
 * Compiled, and cached per template.
 *
 * Compiling on every send would parse nine small strings per registration and, more
 * importantly, would move the point at which a bad stored template fails from "the
 * operator's preview" to "somebody's welcome email". Compiling once per template
 * means the preview and the send run the identical code over the identical source.
 */
interface CompiledTemplate {
  subject: ReturnType<typeof compilePart>;
  text: ReturnType<typeof compilePart>;
  html: ReturnType<typeof compilePart>;
}

/**
 * Resolves a template from the database, falling back to the shipped file.
 *
 * ## The order, and why the database is not the only source
 *
 * An empty `email_templates` table is a supported state, not a broken one. The files
 * are what the application shipped with, the seeder populates the table from them, and
 * a row replaces the file for one template in one locale. That is what makes this
 * phase additive: a deployment that upgrades and writes no rows behaves exactly as it
 * did before, and an operator opts in one template at a time.
 *
 * ## A failure falls back rather than failing the send
 *
 * A stored template that will not compile is an operator's mistake, and it must not
 * become a registration 500. The bad row is logged at `error` and the shipped file
 * renders instead. That trades a wrong-but-working email for a visibly broken one,
 * and the log names the template so the mistake is found.
 *
 * This is the same asymmetry as everywhere else in the mail path: a provider outage
 * costs one email, never the request that triggered it.
 */
/**
 * Renders a template from the shipped files, bypassing the database entirely.
 *
 * The fallback path. `MailService` calls it when the stored row could not be
 * rendered, and it deliberately does not go through `render`, because the stored row
 * is exactly the thing known to be broken.
 */
export function renderShipped<TName extends TemplateName>(
  name: TName,
  data: TemplateDataByName[TName],
): { subject: string; text: string; html: string } {
  const shipped = loadShippedTemplate(name);

  if (!shipped) {
    throw new Error(
      `No shipped template for "${name}", so there is nothing to fall back to.`,
    );
  }

  const context = data as unknown as Record<string, unknown>;
  const body = renderPart(compilePart(shipped.html, `${name} html`), context);

  const shell = layout({
    appName: String(data.appName ?? ''),
    text: renderPart(compilePart(shipped.text, `${name} text`), context),
    html: body,
  });

  return {
    subject: renderPart(
      compilePart(shipped.subject, `${name} subject`),
      context,
    ),
    text: shell.text,
    html: shell.html,
  };
}

/**
 * Renders a candidate template against sample data, persisting nothing.
 *
 * Deliberately the same compiler, the same escaping rules and the same shell as
 * `render`, because a preview that is more forgiving than the send path is worse than
 * no preview: it shows an operator an email that will not be the one delivered. A
 * preview that throws on a triple-brace or a missing field is the feature working.
 */
export async function renderCandidate<TName extends TemplateName>(
  name: TName,
  source: { subject: string; text: string; html: string },
  data: Record<string, unknown>,
): Promise<{ subject: string; text: string; html: string }> {
  // Refused here for the same reason `save` refuses it: a preview that renders an
  // unsafe template teaches the operator the template is fine.
  assertSafeToRender(source.subject, `${name} subject`);
  assertSafeToRender(source.text, `${name} text`);
  assertSafeToRender(source.html, `${name} html`);
  assertKnownHelpers(source.subject, `${name} subject`);
  assertKnownHelpers(source.text, `${name} text`);
  assertKnownHelpers(source.html, `${name} html`);

  const context = { ...sampleData(name), ...data } as unknown as Record<
    string,
    unknown
  >;

  const shell = layout({
    appName: String(context.appName ?? ''),
    text: renderPart(compilePart(source.text, `${name} text`), context),
    html: renderPart(compilePart(source.html, `${name} html`), context),
  });

  return {
    subject: renderPart(
      compilePart(source.subject, `${name} subject`),
      context,
    ),
    text: shell.text,
    html: shell.html,
  };
}

@Injectable()
export class MailTemplateStore {
  private readonly logger = new Logger(MailTemplateStore.name);

  /**
   * Compiled source, keyed the same way as the resolved row.
   *
   * Not in `CacheService`: this is process-local and holds compiled functions, which
   * do not survive serialisation. The distributed cache holds the *source*, and this
   * map sits in front of the compiler so a warm template is a map lookup on both the
   * database path and the file path.
   */
  private readonly compiled = new Map<string, CompiledTemplate>();

  /** How long a resolved template is cached when nothing says otherwise. */
  private static readonly TTL_SECONDS = 300;

  constructor(
    @InjectRepository(EmailTemplate)
    private readonly templates: Repository<EmailTemplate>,
    @InjectRepository(MailTemplateVersion)
    private readonly versions: Repository<MailTemplateVersion>,
    private readonly cache: CacheService,
  ) {}

  /**
   * The source a send would use, compiled and ready.
   *
   * This is the read path. It is `CacheService.wrap` rather than `get`/`set` because
   * a template is small, read on every send and expires on a timer: without request
   * coalescing, a hot template expiring under a burst of registrations has every
   * waiting send read the table at once, which is the stampede the rest of this
   * cache layer exists to prevent.
   */
  async resolve(
    name: TemplateName,
    locale = DEFAULT_LOCALE,
  ): Promise<ResolvedTemplate> {
    const key = mailTemplateKey(name, locale);

    const resolved = await this.cache.wrap<ResolvedTemplate>(
      key,
      async () => this.load(name, locale),
      { ttl: MailTemplateStore.TTL_SECONDS },
    );

    return resolved;
  }

  /**
   * Loads and compiles, from the database when there is a row and from the shipped
   * file when there is not.
   *
   * The row is fetched rather than the fallback being decided in the caller,
   * because "is there an override" is the only question that needs an answer before
   * the render can start.
   */
  private async load(
    name: TemplateName,
    locale: string,
  ): Promise<ResolvedTemplate> {
    const row = await this.templates.findOneBy({ name, locale });

    if (row) {
      return {
        subject: row.subject,
        text: row.text,
        html: row.html,
        origin: 'database',
        version: row.version,
      };
    }

    const shipped = loadShippedTemplate(name);

    if (!shipped) {
      throw new Error(
        `No template for "${name}": the database has no row for locale "${locale}" ` +
          'and the application shipped no file for it. The template name is not in ' +
          'the registry, or the .hbs assets were not copied into the build.',
      );
    }

    return { ...shipped, origin: 'file', version: null };
  }

  /**
   * Compiles one template, caching the result in process.
   *
   * Both the stored and the shipped source go through this, which is the property
   * that matters: the preview an operator sees is produced by the same compiler over
   * the same source that the next send will use.
   */
  private async compiledFor(
    name: TemplateName,
    locale: string,
  ): Promise<CompiledTemplate> {
    const cacheKeyValue = mailTemplateKey(name, locale);
    const existing = this.compiled.get(cacheKeyValue);

    if (existing) {
      return existing;
    }

    const resolved = await this.resolve(name, locale);

    // Only a stored template is untrusted. A file in this repository went through
    // review, which is what the Phase 14 plain functions relied on and the reason
    // the rule is not applied to both.
    if (resolved.origin === 'database') {
      assertSafeToRender(resolved.subject, `${name} subject`);
      assertSafeToRender(resolved.text, `${name} text`);
      assertSafeToRender(resolved.html, `${name} html`);
    }

    const compiled: CompiledTemplate = {
      subject: compilePart(resolved.subject, `${name} subject`),
      text: compilePart(resolved.text, `${name} text`),
      html: compilePart(resolved.html, `${name} html`),
    };

    this.compiled.set(cacheKeyValue, compiled);

    return compiled;
  }

  /**
   * Renders a template to its three parts.
   *
   * The shell is applied here rather than authored in the template, so an operator
   * editing a body cannot remove the "replies are not read" footer or the
   * `text/html` pairing. The body is what they own; the envelope around it is the
   * application's.
   */
  async render<TName extends TemplateName>(
    name: TName,
    data: TemplateDataByName[TName],
    locale = DEFAULT_LOCALE,
  ): Promise<{ subject: string; text: string; html: string }> {
    const compiled = await this.compiledFor(name, locale);

    const context = data as unknown as Record<string, unknown>;
    const body = renderPart(compiled.html, context);

    const shell = layout({
      appName: String(data.appName ?? ''),
      text: renderPart(compiled.text, context),
      html: body,
    });

    return {
      subject: renderPart(compiled.subject, context),
      text: shell.text,
      html: shell.html,
    };
  }

  /**
   * Drops the cached copy of a template so the next send reads the new one.
   *
   * Called after a successful write rather than by the write itself, which keeps the
   * store free of knowledge about who changed what. Both caches go: the distributed
   * one holds the source, and the process-local one holds the compiled form of the
   * source that is now stale.
   */
  async invalidate(name: TemplateName, locale = DEFAULT_LOCALE): Promise<void> {
    this.compiled.delete(mailTemplateKey(name, locale));

    await this.cache.delete(mailTemplateKey(name, locale));
  }

  /**
   * Renders a candidate template without persisting it.
   *
   * A method rather than a direct call to `renderCandidate` so the controller depends
   * on the store rather than reaching past it into a module-level function — the same
   * reason every other route in this repository goes through a service.
   */
  async renderPreview(
    name: TemplateName,
    source: { subject: string; text: string; html: string },
    data: Record<string, unknown> = {},
  ): Promise<{ subject: string; text: string; html: string }> {
    return renderCandidate(name, source, data);
  }

  /**
   * The row as stored, or null when the shipped file is in use.
   *
   * Separate from `resolve` because the admin route needs to distinguish "edited"
   * from "shipped", and `resolve().origin` answers that but not *what is stored*:
   * an operator previewing needs the stored source verbatim, not the compiled one.
   */
  async stored(
    name: TemplateName,
    locale = DEFAULT_LOCALE,
  ): Promise<EmailTemplate | null> {
    return this.templates.findOneBy({ name, locale });
  }

  /**
   * Replaces a template, preserving the version it replaces.
   *
   * The history row is written in the same transaction as the update. A version
   * recorded outside it is a version recorded for a save that then failed, which is
   * the kind of entry that makes a history table untrustworthy.
   */
  async save(input: {
    name: TemplateName;
    locale?: string;
    subject: string;
    text: string;
    html: string;
    updatedBy: string | null;
  }): Promise<EmailTemplate> {
    const locale = input.locale ?? DEFAULT_LOCALE;

    // Refused before the write, not caught after it. A template that reaches the
    // table and is found to be unsafe on the next send is a window during which every
    // send is trying to compile it.
    assertSafeToRender(input.subject, `${input.name} subject`);
    assertSafeToRender(input.text, `${input.name} text`);
    assertSafeToRender(input.html, `${input.name} html`);
    assertKnownHelpers(input.subject, `${input.name} subject`);
    assertKnownHelpers(input.text, `${input.name} text`);
    assertKnownHelpers(input.html, `${input.name} html`);

    // Compiled before the write for the same reason: a template that does not compile
    // must never reach the table, because the render path would fall back to the file
    // and the operator's edit would appear to have been saved and then ignored.
    compilePart(input.subject, `${input.name} subject`);
    compilePart(input.text, `${input.name} text`);
    compilePart(input.html, `${input.name} html`);

    const saved = await this.templates.manager.transaction(async (manager) => {
      const repository = manager.getRepository(EmailTemplate);
      const existing = await repository.findOneBy({
        name: input.name,
        locale,
      });

      if (existing) {
        await manager.getRepository(MailTemplateVersion).insert({
          name: existing.name,
          locale: existing.locale,
          version: existing.version,
          subject: existing.subject,
          text: existing.text,
          html: existing.html,
          updatedBy: existing.updatedBy,
        });

        existing.subject = input.subject;
        existing.text = input.text;
        existing.html = input.html;
        existing.updatedBy = input.updatedBy;
        existing.version += 1;

        return repository.save(existing);
      }

      return repository.save(
        repository.create({
          name: input.name,
          locale,
          subject: input.subject,
          text: input.text,
          html: input.html,
          updatedBy: input.updatedBy,
          version: 1,
        }),
      );
    });

    // After the commit. Deleting inside the transaction would let a send already in
    // flight refill the entry from the row being replaced, and that entry would
    // outlive the edit — the same argument as the auth cache in Phase 17b.
    await this.invalidate(input.name, locale);

    this.logger.log(
      `Stored the ${input.name} template for ${locale} at version ${saved.version}`,
    );

    return saved;
  }

  /** The saved history for a template, newest first. */
  async history(
    name: TemplateName,
    locale = DEFAULT_LOCALE,
    limit = 20,
  ): Promise<MailTemplateVersion[]> {
    return this.versions.find({
      where: { name, locale },
      order: { version: 'DESC' },
      take: limit,
    });
  }

  /**
   * Puts a template back to the shipped file.
   *
   * A delete rather than writing the file's contents into the row, so the row's
   * absence means "shipped" again and a later change to the file takes effect. That
   * is the whole reason the file is the fallback rather than the seed alone.
   */
  async reset(name: TemplateName, locale = DEFAULT_LOCALE): Promise<void> {
    await this.templates.delete({ name, locale });

    await this.invalidate(name, locale);

    this.logger.log(
      `Reset the ${name} template for ${locale} to the shipped file`,
    );
  }
}
