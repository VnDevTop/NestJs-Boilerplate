import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CACHE_NAMESPACE } from '../../core/cache/cache-keys.js';
import { authPreferenceKey } from '../../core/cache/auth-cache.keys.js';
import type { NotificationPreference } from './entities/index.js';
import {
  NotificationPreferencesService,
  type PreferenceEntry,
} from './notification-preferences.service.js';

/**
 * Preferences are read on the delivery path and written by a route, so the two
 * properties worth defending are that the default is "on" and that a write drops the
 * cached copy *after* it lands rather than before.
 */

const KEY = authPreferenceKey('u1');

/**
 * A stored row as the harness holds it.
 *
 * `Omit` rather than `extends`, because the entity declares `id` as required and the
 * insert path has no id until the database assigns one. Extending it would make every
 * row in this file carry a fake uuid.
 */
type Row = Omit<NotificationPreference, 'id'> & { id: string };

const row = (overrides: Partial<Row> = {}): Row =>
  ({
    id: 'p0',
    userId: 'u1',
    event: 'user.registered',
    channel: 'slack',
    enabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as Row;

interface Harness {
  service: NotificationPreferencesService;
  find: ReturnType<typeof vi.fn>;
  findOne: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  deletedKeys: string[];
  /** Rows the repository holds, which is the thing a cached copy can go stale on. */
  rows: Row[];
}

function harness(initial: Row[] = []): Harness {
  const rows = [...initial];
  const deletedKeys: string[] = [];

  const find = vi.fn(async () => [...rows]);
  const findOne = vi.fn(
    async ({ where }: { where: Partial<Row> }) =>
      rows.find(
        (entry) =>
          entry.event === where.event && entry.channel === where.channel,
      ) ?? null,
  );
  const insert = vi.fn(async (value: Row) => {
    rows.push(row(value));
    return { identifiers: [] };
  });
  const save = vi.fn(async (value: Row) => {
    const index = rows.findIndex((entry) => entry.id === value.id);

    if (index >= 0) {
      rows[index] = value;
    }

    return value;
  });
  const remove = vi.fn(async () => ({ affected: 1 }));

  const cache = {
    wrap: async <T>(key: string, loader: () => Promise<T>): Promise<T> =>
      loader(),
    delete: vi.fn(async (key: string) => {
      deletedKeys.push(key);
    }),
  };

  const service = new NotificationPreferencesService(
    { find, findOne, insert, save, delete: remove } as never,
    cache as never,
    { getOrThrow: () => ({ authUserTtl: 60 }) } as never,
  );

  return { service, find, findOne, insert, save, remove, deletedKeys, rows };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the default', () => {
  it('is on, because a table nobody has written to must not silence everything', async () => {
    // The alternative is a fresh install that looks broken, with "seed the table" as
    // the fix — which is the opposite of opt-out.
    const h = harness();

    await expect(
      h.service.isEnabled('u1', 'user.registered', 'slack'),
    ).resolves.toBe(true);
  });

  it('is on for an event with no preference on any channel', async () => {
    const h = harness([row({ event: 'user.deleted', channel: 'slack' })]);

    await expect(
      h.service.isEnabled('u1', 'user.registered', 'slack'),
    ).resolves.toBe(true);
  });

  it('is off only for the pair the user actually changed', async () => {
    const h = harness([row({ event: 'user.registered', channel: 'slack' })]);

    await expect(
      h.service.isEnabled('u1', 'user.registered', 'slack'),
    ).resolves.toBe(false);
    // Same event, different channel: a user who muted Slack has not muted Telegram,
    // and a row-per-pair table is what lets the two answers disagree.
    await expect(
      h.service.isEnabled('u1', 'user.registered', 'telegram'),
    ).resolves.toBe(true);
  });

  it('reads every pair in one query rather than one per event', async () => {
    // This runs on the delivery path, once per channel, so eight preferences must not
    // mean eight queries.
    const h = harness([
      row({ event: 'user.registered', channel: 'slack' }),
      row({ event: 'auth.2fa.enabled', channel: 'slack' }),
    ]);

    await h.service.isEnabled('u1', 'auth.2fa.enabled', 'slack');

    expect(h.find).toHaveBeenCalledTimes(1);
  });

  it('answers on when the lookup throws, because a mute must not silence a deployment', async () => {
    // The cache turns an unreachable redis into a miss and the loader then fails.
    // Throwing here would let a preferences outage silence every operator alert.
    const h = harness();

    h.find.mockRejectedValue(new Error('cache and database are both gone'));

    await expect(
      h.service.isEnabled('u1', 'user.registered', 'slack'),
    ).resolves.toBe(true);
  });
});

describe('list', () => {
  it('reports only the pairs the user changed', async () => {
    const h = harness([
      row({ event: 'user.registered', channel: 'slack', enabled: false }),
      row({ event: 'auth.2fa.enabled', channel: 'console', enabled: true }),
    ]);

    await expect(h.service.list('u1')).resolves.toEqual([
      { event: 'user.registered', channel: 'slack', enabled: false },
      { event: 'auth.2fa.enabled', channel: 'console', enabled: true },
    ]);
  });

  it('is empty for a user who has changed nothing', async () => {
    await expect(harness().service.list('u1')).resolves.toEqual([]);
  });
});

describe('apply', () => {
  const entries: PreferenceEntry[] = [
    { event: 'user.registered', channel: 'slack', enabled: false },
  ];

  it('inserts a pair that has no row yet', async () => {
    const h = harness();

    await h.service.apply('u1', entries);

    expect(h.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        event: 'user.registered',
        channel: 'slack',
        enabled: false,
      }),
    );
  });

  it('updates an existing row rather than inserting a second one', async () => {
    // The unique index would reject the insert, so an upsert-by-insert would fail on
    // the second save of the same pair rather than changing anything.
    const h = harness([row({ id: 'p1', enabled: true })]);

    await h.service.apply('u1', entries);

    expect(h.insert).not.toHaveBeenCalled();
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1', enabled: false }),
    );
  });

  it('writes an explicit true rather than skipping it', async () => {
    // An explicit re-enable is not a no-op the caller can see the effect of, and
    // writing it makes `updatedAt` mean "this was touched".
    const h = harness([row({ id: 'p1', enabled: false })]);

    await h.service.apply('u1', [
      { event: 'user.registered', channel: 'slack', enabled: true },
    ]);

    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });

  it('leaves pairs it was not asked about alone', async () => {
    // A list replace would silently clear preferences the client never knew about: a
    // client built before an event existed would wipe it on every save.
    const h = harness([
      row({ id: 'p1', event: 'auth.2fa.enabled', enabled: false }),
    ]);

    await h.service.apply('u1', entries);

    // One lookup, for the one pair being written. The untouched row keeps its id and
    // its value, which is the whole property: a list replace would have dropped it.
    expect(h.findOne).toHaveBeenCalledTimes(1);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.rows).toEqual([
      expect.objectContaining({
        id: 'p1',
        event: 'auth.2fa.enabled',
        enabled: false,
      }),
      expect.objectContaining({ event: 'user.registered', enabled: false }),
    ]);
  });

  it('drops the cached copy once, after every write, never between them', async () => {
    // An eviction landing between two writes would let a concurrent read refill from
    // a half-applied state and cache that answer for the rest of the TTL. This is the
    // same after-the-commit rule every other invalidation in this application follows.
    const h = harness();

    await h.service.apply('u1', [
      { event: 'user.registered', channel: 'slack', enabled: false },
      { event: 'auth.2fa.enabled', channel: 'slack', enabled: false },
      { event: 'auth.2fa.disabled', channel: 'slack', enabled: false },
    ]);

    expect(h.insert).toHaveBeenCalledTimes(3);
    expect(h.deletedKeys).toEqual([KEY]);
  });

  it('drops the cache even when the batch is empty, so it costs nothing extra', async () => {
    const h = harness();

    await h.service.apply('u1', []);

    expect(h.deletedKeys).toEqual([KEY]);
  });

  it("drops only this user's key, not the claims entry", async () => {
    // The claims entry is read on every authenticated request; evicting it here would
    // put a database query back on the hot path for no reason.
    const h = harness();

    await h.service.apply('u1', entries);

    expect(h.deletedKeys).toEqual([KEY]);
    expect(KEY).toContain(CACHE_NAMESPACE.User);
    expect(KEY.endsWith('notifications')).toBe(true);
  });
});

describe('clear', () => {
  it('removes the row, so the pair reverts to the default', async () => {
    const h = harness();

    await expect(
      h.service.clear('u1', 'user.registered', 'slack'),
    ).resolves.toBe(true);
    expect(h.remove).toHaveBeenCalledWith({
      userId: 'u1',
      event: 'user.registered',
      channel: 'slack',
    });
  });

  it('reports false when there was nothing to remove', async () => {
    const h = harness();

    h.remove.mockResolvedValue({ affected: 0 });

    await expect(
      h.service.clear('u1', 'user.registered', 'slack'),
    ).resolves.toBe(false);
  });

  it('drops the cached copy, because a stale entry would re-mute the pair', async () => {
    const h = harness();

    await h.service.clear('u1', 'user.registered', 'slack');

    expect(h.deletedKeys).toEqual([KEY]);
  });
});
