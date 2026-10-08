import { NotFoundException } from '@nestjs/common';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceService } from './device.service.js';
import type { UserDevice } from './entities/index.js';

/**
 * The per-device counter is the thing that makes signing out of one browser leave
 * the phone signed in. Two properties are worth defending and neither is obvious
 * from the method name:
 *
 * - the version has to move, because the strategy never reads `isActive`, so a
 *   revoked device whose row still exists is otherwise indistinguishable from a
 *   live one;
 * - the cached answers have to be dropped *after* the statement, because a read
 *   landing in between refills the map from the row being revoked and keeps the
 *   token alive for the rest of the TTL.
 */

const DEVICE = { id: 'd1', userId: 'u1', isActive: true } as UserDevice;

function harness(options: { device?: UserDevice | null } = {}) {
  const device = options.device === undefined ? DEVICE : options.device;

  const save = vi.fn(async (value: Partial<UserDevice>) => value as UserDevice);
  const increment = vi.fn().mockResolvedValue({ affected: 1 });
  const find = vi.fn().mockResolvedValue([]);
  const findOne = vi.fn().mockResolvedValue(device);

  const usersService = {
    invalidateAuthCache: vi.fn().mockResolvedValue(undefined),
  };
  const store = new Map<string, unknown>();

  const cache = {
    wrap: async <T>(key: string, loader: () => Promise<T>): Promise<T> => {
      if (store.has(key)) {
        return store.get(key) as T;
      }

      const value = await loader();
      store.set(key, value);

      return value;
    },
    deleteKeys: async (...keys: string[]) => {
      for (const key of keys) {
        store.delete(key);
      }
    },
  };

  const service = new DeviceService(
    {
      find,
      findOne,
      save,
      increment,
      update: vi.fn().mockResolvedValue({ affected: 1 }),
      manager: {},
    } as never,
    usersService as never,
    cache as never,
    { getOrThrow: () => ({ authUserTtl: 60 }) } as never,
  );

  return {
    service,
    save,
    increment,
    find,
    findOne,
    usersService,
    store,
  };
}

describe('revoke', () => {
  it('moves the version, which is what actually revokes', async () => {
    // `isActive` alone would not: the strategy never reads that column, so a
    // revoked device with a row still in the table looks live.
    const h = harness();

    await h.service.revoke('u1', 'd1');

    expect(h.save.mock.calls[0][0].sessionsVersion).toBe(1);
    expect(h.save.mock.calls[0][0].isActive).toBe(false);
  });

  it('bumps from the stored version rather than resetting to one', async () => {
    // A device revoked twice must produce two different numbers, or a token minted
    // between the two cannot be told from one minted before the first.
    const h = harness({
      device: { ...DEVICE, sessionsVersion: 4 } as UserDevice,
    });

    await h.service.revoke('u1', 'd1');

    expect(h.save.mock.calls[0][0].sessionsVersion).toBe(5);
  });

  it('drops the cached answers about the owner', async () => {
    const h = harness();

    await h.service.revoke('u1', 'd1');

    expect(h.usersService.invalidateAuthCache).toHaveBeenCalledWith('u1');
  });

  it('drops them after the write, not before', async () => {
    const h = harness();
    const order: string[] = [];

    h.save.mockImplementation(async () => {
      order.push('write');
      return DEVICE;
    });
    h.usersService.invalidateAuthCache.mockImplementation(async () => {
      order.push('invalidate');
    });

    await h.service.revoke('u1', 'd1');

    expect(order).toEqual(['write', 'invalidate']);
  });

  it('drops them even when the write fails', async () => {
    const h = harness();
    h.save.mockRejectedValue(new Error('connection lost'));

    await expect(h.service.revoke('u1', 'd1')).rejects.toThrow();

    expect(h.usersService.invalidateAuthCache).toHaveBeenCalledWith('u1');
  });

  it("refuses a device that is not the caller's, without touching anything", async () => {
    const h = harness({ device: null });

    await expect(h.service.revoke('u1', 'd1')).rejects.toThrow(
      NotFoundException,
    );
    expect(h.usersService.invalidateAuthCache).not.toHaveBeenCalled();
  });
});

describe('revokeDeviceSessions', () => {
  it('increments the one device, scoped to its owner', async () => {
    const h = harness();

    await h.service.revokeDeviceSessions('u1', 'd1');

    expect(h.increment).toHaveBeenCalledWith(
      { id: 'd1', userId: 'u1' },
      'sessionsVersion',
      1,
    );
  });

  it('drops the cached answers after the increment', async () => {
    const h = harness();
    const order: string[] = [];

    h.increment.mockImplementation(async () => {
      order.push('increment');
      return { affected: 1 };
    });
    h.usersService.invalidateAuthCache.mockImplementation(async () => {
      order.push('invalidate');
    });

    await h.service.revokeDeviceSessions('u1', 'd1');

    expect(order).toEqual(['increment', 'invalidate']);
  });

  it('drops them even when the increment fails', async () => {
    // The cache entry is what makes the stale version dangerous, so it goes
    // whatever the statement did.
    const h = harness();
    h.increment.mockRejectedValue(new Error('deadlock'));

    await expect(h.service.revokeDeviceSessions('u1', 'd1')).rejects.toThrow(
      'deadlock',
    );

    expect(h.usersService.invalidateAuthCache).toHaveBeenCalledWith('u1');
  });
});

describe('revokeAllByUserId', () => {
  it('drops the cached answers as well as deactivating every device', async () => {
    // Every device of the user moves, so the map behind every token on this
    // account is now wrong.
    const h = harness();

    await h.service.revokeAllByUserId('u1');

    expect(h.usersService.invalidateAuthCache).toHaveBeenCalledWith('u1');
  });
});

describe('findSessionVersions', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  it('keys the answer by device id', async () => {
    h.find.mockResolvedValue([
      { id: 'd1', sessionsVersion: 0 },
      { id: 'd2', sessionsVersion: 3 },
    ]);

    expect(await h.service.findSessionVersions('u1')).toEqual({
      d1: 0,
      d2: 3,
    });
  });

  it('includes revoked devices, because an absent one is refused', async () => {
    // If only active devices were returned, a revoked device would look like a
    // deleted one and, worse, an entry that expired would look like "not mine".
    h.find.mockResolvedValue([{ id: 'd1', sessionsVersion: 2 }]);

    expect(await h.service.findSessionVersions('u1')).toEqual({ d1: 2 });
  });

  it('does not filter on isActive', async () => {
    h.find.mockResolvedValue([{ id: 'd1', sessionsVersion: 0 }]);

    await h.service.findSessionVersions('u1');

    expect(h.find.mock.calls[0][0].where).toEqual({ userId: 'u1' });
  });

  it('reads a device predating the column as version zero', async () => {
    h.find.mockResolvedValue([{ id: 'd1', sessionsVersion: undefined }]);

    expect(await h.service.findSessionVersions('u1')).toEqual({ d1: 0 });
  });

  it('is read once per user, not once per token', async () => {
    h.find.mockResolvedValue([{ id: 'd1', sessionsVersion: 0 }]);

    await h.service.findSessionVersions('u1');
    await h.service.findSessionVersions('u1');

    expect(h.find).toHaveBeenCalledTimes(1);
  });
});
