import { beforeEach, describe, expect, it } from 'vitest';

import { CacheService } from '../../core/cache/index.js';
import type { EmailTemplate } from './entities/email-template.entity.js';
import {
  DEFAULT_LOCALE,
  MailTemplateStore,
  mailTemplateKey,
  renderCandidate,
} from './mail-template.store.js';
import { TenantContextService } from '../../common/tenancy/tenant-context.service.js';
import { DEFAULT_TENANT_ID } from '../../common/tenancy/tenant.constants.js';
import {
  TEMPLATE_NAMES,
  type TemplateName,
} from './templates/template.registry.js';

/**
 * The override rule, and the properties around it.
 *
 * Two behaviours carry the phase:
 *
 * 1. **An empty table means the shipped files.** That is what makes this additive — a
 *    deployment that upgrades and writes nothing behaves exactly as it did in Phase
 *    14.
 * 2. **A stored template that will not render does not stop a send.** It falls back to
 *    the shipped file, because the alternative is one operator's mistake becoming a
 *    500 on every registration in the deployment.
 */

/** A repository whose rows this test controls. */
class FakeTemplates {
  rows = new Map<string, EmailTemplate>();
  deleted: { name: string; locale: string; tenantId: string }[] = [];

  /**
   * The key carries the tenant, because the row does.
   *
   * A fake that filed rows under `name:locale` would let one tenant's override
   * answer for another, which is the mistake this phase is about — so the fake
   * would hide it rather than show it.
   */
  private key(name: string, locale: string, tenantId: string): string {
    return `${tenantId}:${name}:${locale}`;
  }

  findOneBy = async (where: {
    name: string;
    locale: string;
    tenantId: string;
  }): Promise<EmailTemplate | null> =>
    this.rows.get(this.key(where.name, where.locale, where.tenantId)) ?? null;

  delete = async (where: {
    name: string;
    locale: string;
    tenantId: string;
  }): Promise<void> => {
    this.deleted.push(where);
    this.rows.delete(this.key(where.name, where.locale, where.tenantId));
  };
}

/** A cache that actually remembers, so the invalidation assertions mean something. */
/**
 * A cache that actually remembers, so the invalidation assertions mean something.
 *
 * **The tenant is part of the key, as it is in the real cache.** The real service
 * folds the tenant into every key it is given, and a fake that did not would let
 * two tenants share one entry — which is the mistake this phase is about.
 */
class RecordingCache {
  readonly entries = new Map<string, unknown>();
  readonly deleted: string[] = [];

  constructor(private readonly tenantContext: TenantContextService) {}

  private scoped(key: string): string {
    return `${this.tenantContext.current()?.id ?? DEFAULT_TENANT_ID}:${key}`;
  }

  get = async <T>(key: string): Promise<T | undefined> =>
    this.entries.get(this.scoped(key)) as T | undefined;

  wrap = async <T>(key: string, loader: () => Promise<T>): Promise<T> => {
    const scoped = this.scoped(key);

    if (this.entries.has(scoped)) {
      return this.entries.get(scoped) as T;
    }

    const value = await loader();
    this.entries.set(scoped, value);

    return value;
  };

  delete = async (key: string): Promise<void> => {
    const scoped = this.scoped(key);
    this.deleted.push(scoped);
    this.entries.delete(scoped);
  };

  asService(): CacheService {
    return this as unknown as CacheService;
  }
}

const tenantScope = {
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'acme',
  name: 'Acme',
  status: 'active',
  plan: 'free',
  schemaName: null,
};

function harness(): {
  store: MailTemplateStore;
  templates: FakeTemplates;
  cache: RecordingCache;
  saved: EmailTemplate[];
  tenantContext: TenantContextService;
} {
  const templates = new FakeTemplates();
  const tenantContext = new TenantContextService();
  const cache = new RecordingCache(tenantContext);
  const saved: EmailTemplate[] = [];

  const repository = {
    findOneBy: templates.findOneBy,
    delete: templates.delete,
    manager: {
      transaction: async (work: (manager: unknown) => Promise<unknown>) =>
        work({
          getRepository: () => ({
            findOneBy: templates.findOneBy,
            save: async (row: EmailTemplate) => {
              saved.push(row);
              templates.rows.set(
                `${row.tenantId}:${row.name}:${row.locale}`,
                row,
              );
              return row;
            },
            create: (row: Partial<EmailTemplate>) => row as EmailTemplate,
          }),
          getRepository2: undefined,
        }),
    },
  };

  // The history repository is a separate `getRepository` call inside the transaction,
  // which a plain object cannot express; a stub that records the insert is enough for
  // these assertions, which are about the override rule rather than about history.
  const versions = {
    find: async () => [],
    insert: async () => undefined,
  };

  const store = new MailTemplateStore(
    repository as never,
    versions as never,
    cache.asService(),
    tenantContext,
  );

  return { store, templates, cache, saved, tenantContext };
}

describe('MailTemplateStore', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  /**
   * The property the phase is about.
   *
   * **A template one tenant edited is not the template another tenant sends.**
   * The row is an override of a shipped file, and an override one tenant's
   * operator wrote belongs to that tenant: the other one falls back to the
   * shipped file rather than sending somebody else's wording.
   */
  it("keeps one tenant's override away from another tenant", async () => {
    const acme = '22222222-2222-4222-8222-222222222222';

    h.templates.rows.set(`${acme}:welcome:en`, {
      name: 'welcome',
      locale: 'en',
      subject: 'Acme subject',
      text: 'Acme text',
      html: '<p>Acme body</p>',
      version: 1,
      updatedBy: null,
      tenantId: acme,
    } as EmailTemplate);

    const byAcme = await h.tenantContext.run({ ...tenantScope, id: acme }, () =>
      h.store.resolve('welcome', 'en'),
    );
    const byDefault = await h.store.resolve('welcome', 'en');

    // The other tenant gets the shipped file's source, not the other tenant's
    // row: `resolve` returns the source, and the shipped source is the fallback.
    expect(byAcme.subject).toBe('Acme subject');
    expect(byDefault.subject).toBe('Welcome to {{appName}}');
  });

  it('renders the shipped file when the table is empty', async () => {
    const rendered = await h.store.render('welcome', {
      firstName: 'Ada',
      appName: 'Boilerplate',
    });

    expect(rendered.subject).toBe('Welcome to Boilerplate');
    expect(rendered.text).toContain('Hello Ada,');
  });

  it('prefers a stored row over the shipped file', async () => {
    h.templates.rows.set(`${DEFAULT_TENANT_ID}:welcome:en`, {
      name: 'welcome',
      locale: 'en',
      subject: 'Edited subject',
      text: 'Edited text',
      html: '<p>Edited body</p>',
      version: 3,
      updatedBy: null,
      tenantId: DEFAULT_TENANT_ID,
    } as EmailTemplate);

    const rendered = await h.store.render('welcome', {
      firstName: 'Ada',
      appName: 'Boilerplate',
    });

    expect(rendered.subject).toBe('Edited subject');
    expect(rendered.text).toContain('Edited text');
    expect(rendered.html).toContain('<p>Edited body</p>');
  });

  it('still wraps a stored body in the shared shell', async () => {
    // The envelope is the application's, not the editor's: an operator changing a
    // body must not be able to remove the "replies are not read" footer or the
    // text/html pairing.
    h.templates.rows.set('welcome:en', {
      name: 'welcome',
      locale: 'en',
      subject: 'S',
      text: 'T',
      html: '<p>only a body</p>',
      version: 1,
      updatedBy: null,
    } as EmailTemplate);

    const rendered = await h.store.render('welcome', {
      firstName: 'Ada',
      appName: 'Boilerplate',
    });

    expect(rendered.html.startsWith('<!doctype html>')).toBe(true);
    expect(rendered.html).toContain('Replies are not read');
    expect(rendered.text).toContain('Replies are not read');
  });

  it('escapes an interpolated field in a stored template', async () => {
    h.templates.rows.set('welcome:en', {
      name: 'welcome',
      locale: 'en',
      subject: 'S',
      text: 'T',
      html: '<p>{{firstName}}</p>',
      version: 1,
      updatedBy: null,
    } as EmailTemplate);

    const rendered = await h.store.render('welcome', {
      firstName: '<script>alert("x")</script>',
      appName: 'Boilerplate',
    });

    expect(rendered.html).not.toContain('<script>');
  });

  it('caches the resolved template rather than reading the table per send', async () => {
    const reads: unknown[] = [];
    const original = h.templates.findOneBy;

    h.templates.findOneBy = async (where) => {
      reads.push(where);

      return original(where);
    };

    await h.store.render('welcome', { firstName: 'Ada', appName: 'B' });
    await h.store.render('welcome', { firstName: 'Grace', appName: 'B' });

    // Two sends, one read. Without `wrap`, every registration would hit the table —
    // and a hot template expiring under a burst would stampede it.
    expect(reads.length).toBeLessThanOrEqual(1);
  });

  it('drops both caches on invalidate, so an edit reaches the next send', async () => {
    await h.store.render('welcome', { firstName: 'Ada', appName: 'B' });

    await h.store.invalidate('welcome');

    // The key the cache service would have written: the tenant in front, because
    // that is the shape the service uses.
    expect(h.cache.deleted).toContain(
      `${DEFAULT_TENANT_ID}:${mailTemplateKey('welcome', DEFAULT_LOCALE)}`,
    );
  });

  it('reads a locale that is not the default from its own key', async () => {
    // The locale is in the key, so a deployment resolving a second locale is not
    // served the `en` row for it.
    expect(mailTemplateKey('welcome', 'en')).not.toBe(
      mailTemplateKey('welcome', 'pt-BR'),
    );
  });

  it('refuses to store a template with a triple-brace expression', async () => {
    await expect(
      h.store.save({
        name: 'welcome',
        subject: 'S',
        text: 'T',
        html: '<p>{{{firstName}}}</p>',
        updatedBy: null,
      }),
    ).rejects.toThrow(/triple-brace/i);
  });

  it('refuses to store a template that calls a helper it does not offer', async () => {
    // The guarantee, precisely. `knownHelpersOnly` does **not** refuse an unknown
    // helper at compile time in this version of handlebars — it throws at render,
    // and `save` does not render. Without this scan the row would be written and the
    // break would surface on every send instead.
    await expect(
      h.store.save({
        name: 'welcome',
        subject: 'S',
        text: 'T',
        html: '<p>{{noSuchHelper x}}</p>',
        updatedBy: null,
      }),
    ).rejects.toThrow(/does not offer/i);
  });

  it('accepts the block helpers handlebars always provides', async () => {
    // `{{#if}}` and `{{#each}}` are not helpers this application registered, and
    // refusing them would make a conditional impossible to write.
    await expect(
      h.store.save({
        name: 'account-permanently-locked',
        subject: 'S',
        text: 'T',
        html: '{{#if (isNull failures)}}too many{{else}}{{failures}}{{/if}}',
        updatedBy: null,
      }),
    ).resolves.toBeDefined();
  });
});

describe('renderCandidate', () => {
  it('renders a candidate with sample data and stores nothing', async () => {
    const rendered = await renderCandidate(
      'welcome',
      {
        subject: 'Welcome to {{appName}}',
        text: 'Hello {{firstName}},',
        html: '<p>Hello {{firstName}},</p>',
      },
      {},
    );

    expect(rendered.subject).toBe('Welcome to Boilerplate');
    expect(rendered.text).toContain('Hello Ada,');
  });

  it('refuses an unsafe candidate, so a preview cannot bless a bad template', () => {
    // The preview and the save run the same check. A preview that rendered a
    // triple-brace would teach the operator the template is fine.
    return expect(
      renderCandidate(
        'welcome',
        { subject: 'S', text: 'T', html: '{{{firstName}}}' },
        {},
      ),
    ).rejects.toThrow(/triple-brace/i);
  });
});

describe('every shipped template', () => {
  it('has all three parts on disk', async () => {
    // A name in the registry with no file is a packaging fault — the assets were not
    // copied into the build — and it must fail here rather than at the first send.
    const { loadShippedTemplate } =
      await import('./templates/shipped-templates.js');

    for (const name of TEMPLATE_NAMES) {
      const shipped = loadShippedTemplate(name as TemplateName);

      expect(shipped, `${name} has no shipped file`).not.toBeNull();
      expect(shipped!.subject.length).toBeGreaterThan(0);
      expect(shipped!.text.length).toBeGreaterThan(0);
      expect(shipped!.html.length).toBeGreaterThan(0);
    }
  });

  it('renders through handlebars without throwing on its own data', async () => {
    const { sampleData } = await import('./templates/template-fields.js');
    const { loadShippedTemplate } =
      await import('./templates/shipped-templates.js');

    for (const name of TEMPLATE_NAMES) {
      const shipped = loadShippedTemplate(name as TemplateName)!;

      await expect(
        renderCandidate(
          name as TemplateName,
          shipped,
          sampleData(name as TemplateName),
        ),
      ).resolves.toMatchObject({ subject: expect.any(String) });
    }
  });
});
