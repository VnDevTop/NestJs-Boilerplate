import { describe, expect, it, vi } from 'vitest';
import { OptimisticLockVersionMismatchError } from 'typeorm';

import { UsersService } from './users.service.js';

/**
 * The lost update, and what it looks like from both sides.
 *
 * The failure is quiet, which is the whole problem: two administrators open the
 * same profile, one saves a role change, the other saves a name change from a form
 * it loaded before that. Without a version column the second save writes the stale
 * role back and **both get a 200**. Nobody sees an error. The demotion is gone and
 * the audit log says the role was changed twice.
 *
 * So these tests are mostly about one thing — the second save must not succeed —
 * and the one that matters most is the negative control: remove the conflict and
 * the test has to fail.
 */

/**
 * A service whose `findOne` returns one row and whose `save` behaves the way
 * TypeORM does with a `@VersionColumn`.
 *
 * `stored` and `loaded` are separate on purpose: the conflict is precisely the gap
 * between the row a form was filled in from and the row in the database now, and a
 * harness with one row for both can never express it. `save` throws exactly when
 * `loaded.version` differs from `stored.version` — the condition TypeORM turns into
 * `OptimisticLockVersionMismatchError` when the update affects no rows.
 */
function harness(
  options: {
    stored?: Record<string, unknown>;
    loaded?: Record<string, unknown>;
  } = {},
) {
  const stored = options.stored ?? { ...ROW };
  const loaded = options.loaded ?? { ...stored };
  const saved: Record<string, unknown>[] = [];

  const save = vi.fn(async (value: Record<string, unknown>) => {
    const storedVersion = stored['version'] as number;
    const presented = (value['version'] as number | undefined) ?? 1;

    if (presented !== storedVersion) {
      throw new OptimisticLockVersionMismatchError(
        loaded['id'] as string,
        presented,
        storedVersion,
      );
    }

    saved.push(value);
    Object.assign(stored, value, { version: storedVersion + 1 });

    return { ...stored };
  });

  const merge = vi.fn((base: unknown, dto: unknown) => ({
    ...(base as object),
    ...(dto as object),
  }));
  const deleteKeys = vi.fn(async () => undefined);

  const service = new UsersService(
    { findOne: vi.fn(async () => loaded), save, merge } as never,
    { deleteKeys } as never,
    { getOrThrow: () => ({ authUserTtl: 60 }) } as never,
    {
      notify: vi.fn(async () => ({ notificationId: 'n1', queued: true })),
    } as never,
  );

  return { service, save, merge, saved, stored, deleteKeys };
}

const ROW = {
  id: 'u1',
  email: 'a@x.com',
  role: 'user',
  isManager: false,
  isActive: true,
  sessionsVersion: 0,
  isEmailVerified: true,
  lockedAt: null,
  version: 3,
};

describe('one editor at a time', () => {
  it('saves normally', async () => {
    // The control. Without this, the conflict tests below would pass on a service
    // that refused every save.
    const h = harness();

    await expect(
      h.service.update('u1', { firstName: 'Ada' } as never),
    ).resolves.toMatchObject({ firstName: 'Ada' });
  });

  it('bumps the stored version on a successful save', async () => {
    // The mechanism, asserted directly: without the bump there is nothing for the
    // next stale form to miss.
    const h = harness();

    await h.service.update('u1', { firstName: 'Ada' } as never);

    expect(h.stored['version']).toBe(ROW.version + 1);
  });
});

describe('two editors, one stale form', () => {
  it('refuses the second save instead of overwriting the first', async () => {
    // The scenario the whole column exists for. The first editor's save moved the
    // version; the second editor's form was filled in before that, so its save
    // matches no row — and the role change the first one made survives.
    const stored = { ...ROW };
    const h = harness({ stored });

    await h.service.update('u1', { role: 'admin' } as never);

    // The second editor's browser still holds the row as it was at version 3.
    const second = harness({ stored, loaded: { ...ROW } });

    await expect(
      second.service.update('u1', { firstName: 'Grace' } as never),
    ).rejects.toMatchObject({ status: 409 });
    expect(stored['role']).toBe('admin');
  });

  it('answers 409 rather than 500, so a client reloads instead of paging somebody', async () => {
    // It is a conflict between two requests, not a fault. A 500 reads as "the
    // application is broken", and a client that believes that retries the save.
    const h = harness({ stored: { ...ROW }, loaded: { ...ROW, version: 2 } });

    await expect(
      h.service.update('u1', { firstName: 'Ada' } as never),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('says what to do about it', async () => {
    // "Conflict" on its own tells a person nothing. The instruction to reload is the
    // part that turns a 409 from a dead end into a next step.
    const h = harness({ stored: { ...ROW }, loaded: { ...ROW, version: 9 } });

    await expect(
      h.service.update('u1', { firstName: 'Ada' } as never),
    ).rejects.toThrow(/Reload/);
  });

  it('does not drop the cache entry, because nothing was written', async () => {
    // The invalidation is unconditional on the success path, but there is no
    // success here. Dropping the entry would send the next reader to the database
    // for an answer that did not change.
    const h = harness({ stored: { ...ROW }, loaded: { ...ROW, version: 7 } });

    await h.service
      .update('u1', { firstName: 'Ada' } as never)
      .catch(() => undefined);

    expect(h.deleteKeys).not.toHaveBeenCalled();
  });
});

describe('the counter itself', () => {
  it('is compared, not just carried', async () => {
    // TypeORM's semantics are "the version read is compared and incremented", so a
    // row at zero would be indistinguishable from a row whose version was never
    // set. Asserted through the save rather than the column: a version that is
    // stored but never compared is a counter nobody reads.
    const h = harness({ stored: { ...ROW }, loaded: { ...ROW } });

    await h.service.update('u1', { firstName: 'Ada' } as never);

    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({ version: ROW.version }),
    );
  });

  it('is on the entity, which is what makes `save()` emit the WHERE clause', async () => {
    // The migration alone changes nothing. Without the decorator TypeORM has no
    // reason to look at the column, and the row would update unconditionally —
    // the feature silently off, with the column present as evidence that it is on.
    const { getMetadataArgsStorage } = await import('typeorm');
    const { User } = await import('./entities/index.js');

    const version = getMetadataArgsStorage()
      .columns.filter((column) => column.target === User)
      .find((column) => column.propertyName === 'version');

    expect(version?.options).toMatchObject({ type: 'integer' });
  });
});
