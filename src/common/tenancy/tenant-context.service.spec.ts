import { describe, expect, it } from 'vitest';

import {
  TenantContextService,
  type TenantScope,
} from './tenant-context.service.js';

const acme: TenantScope = {
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'acme',
  name: 'Acme',
  status: 'active',
  plan: 'free',
  schemaName: null,
};

describe('the tenant context', () => {
  it('is there inside the work', () => {
    const context = new TenantContextService();

    const seen = context.run(acme, () => context.current());

    expect(seen).toEqual(acme);
  });

  it('is gone afterwards', () => {
    const context = new TenantContextService();

    context.run(acme, () => undefined);

    // The scope ends with the work. A callback that outlived the request would
    // keep the tenant alive, and the work would be done in a context that says
    // something that is no longer true.
    expect(context.current()).toBeUndefined();
  });

  it('survives the awaits inside the work', async () => {
    const context = new TenantContextService();

    const seen = await context.run(acme, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));

      return context.current();
    });

    // The context follows the async call chain, which is the whole reason it
    // is on AsyncLocalStorage and not a parameter.
    expect(seen).toEqual(acme);
  });

  it('nests, and the inner one wins', () => {
    const context = new TenantContextService();
    const other: TenantScope = { ...acme, id: '33333333', slug: 'other' };

    const seen = context.run(acme, () =>
      context.run(other, () => context.current()),
    );

    expect(seen?.slug).toBe('other');
  });

  it('refuses to work without a tenant', () => {
    const context = new TenantContextService();

    // A repository with no tenant to scope its query by would read the whole
    // table, and the whole table is every tenant's rows.
    expect(() => context.require()).toThrow(/not running as a tenant/);
  });

  it('returns the tenant when there is one', () => {
    const context = new TenantContextService();

    const seen = context.run(acme, () => context.require());

    expect(seen.id).toBe(acme.id);
  });
});
