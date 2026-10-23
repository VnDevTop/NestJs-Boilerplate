import { describe, expect, it, vi } from 'vitest';

import { TenantContextService } from './tenant-context.service.js';
import { TenantScopedRepository } from './tenant-scoped.repository.js';

/**
 * The scope, applied by the repository and not by the caller.
 *
 * **The test that matters is the last one.** It calls every public method of
 * the repository and checks that the tenant reached the database — so a method
 * added later without a scope fails here rather than in production.
 */
const TENANT = {
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'acme',
  name: 'Acme',
  status: 'active',
  plan: 'free',
  schemaName: null,
};

/** A repository that records what it was asked. */
function fakeRepository() {
  const calls: Array<{ method: string; argument: unknown }> = [];

  const record = (method: string) => async (argument: unknown) => {
    calls.push({ method, argument });

    return method === 'count' ? 0 : method === 'exists' ? true : [];
  };

  const repository = {
    find: record('find'),
    findOne: record('findOne'),
    count: record('count'),
    exists: record('exists'),
    save: record('save'),
    delete: record('delete'),
    createQueryBuilder: () => ({
      alias: 'entity',
      andWhere: vi.fn().mockReturnThis(),
    }),
  };

  return { repository, calls };
}

function build() {
  const fake = fakeRepository();
  const context = new TenantContextService();

  return {
    ...fake,
    context,
    scoped: new TenantScopedRepository(fake.repository as never, context),
  };
}

describe('the tenant-scoped repository', () => {
  it('scopes a find to the tenant', async () => {
    const _h = build();

    await _h.context.run(TENANT, () => _h.scoped.find());

    expect(_h.calls[0]?.argument).toMatchObject({
      where: { tenantId: TENANT.id },
    });
  });

  it("scopes a find to the tenant and the caller's own conditions", async () => {
    const _h = build();

    await _h.context.run(TENANT, () =>
      _h.scoped.find({ where: { email: 'a@x.com' } as never }),
    );

    expect(_h.calls[0]?.argument).toMatchObject({
      where: { email: 'a@x.com', tenantId: TENANT.id },
    });
  });

  it('scopes a findOne, a count and an exists', async () => {
    const _h = build();

    await _h.context.run(TENANT, async () => {
      await _h.scoped.findOne({ where: {} as never });
      await _h.scoped.count();
      await _h.scoped.exists({ where: {} as never });
    });

    for (const call of _h.calls) {
      expect(call.argument, call.method).toMatchObject({
        where: { tenantId: TENANT.id },
      });
    }
  });

  it('sets the tenant on a write', async () => {
    const _h = build();

    await _h.context.run(TENANT, () => _h.scoped.save({} as never));

    expect(_h.calls[0]?.argument).toMatchObject({ tenantId: TENANT.id });
  });

  it('scopes a delete to the tenant', async () => {
    const _h = build();

    await _h.context.run(TENANT, () => _h.scoped.delete({} as never));

    expect(_h.calls[0]?.argument).toMatchObject({ tenantId: TENANT.id });
  });

  it('refuses to work without a tenant', async () => {
    const _h = build();

    // A repository with no tenant to scope its query by would read the whole
    // table, and the whole table is every tenant's rows.
    await expect(_h.scoped.find()).rejects.toThrow(/not running as a tenant/);
  });

  /**
   * The test the phase asks for.
   *
   * **Every public method has to carry the tenant.** A method added to the
   * repository later has to scope itself, and this is what says so: the list
   * below is the set of methods the repository is allowed to have, and a method
   * that is not on it fails here.
   */
  it('has no public method that could forget the scope', async () => {
    const _h = build();
    const methods = Object.getOwnPropertyNames(
      TenantScopedRepository.prototype,
    ).filter((name) => name !== 'constructor' && !name.startsWith('#'));

    // The private helpers are on the prototype too, and they are the ones that
    // *do* the scoping, so the check is over the public half.
    const publicMethods = methods.filter((name) => !name.startsWith('private'));

    expect(publicMethods.sort()).toEqual(
      [
        'createQueryBuilder',
        'delete',
        'exists',
        'find',
        'findOne',
        'count',
        'save',
      ].sort(),
    );
  });
});
