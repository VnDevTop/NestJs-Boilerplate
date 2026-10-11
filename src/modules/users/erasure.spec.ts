import { describe, expect, it, vi } from 'vitest';

import { User } from './entities/index.js';
import { UsersService } from './users.service.js';

/**
 * The right to erasure, and what it deliberately does not do.
 *
 * Two properties carry the feature, and the second one is the one that is easy to
 * get wrong:
 *
 * 1. **Soft, not immediate.** The row stays for the retention window so a deletion
 *    made in anger can be reversed by an operator.
 * 2. **The clock does not restart on a retry.** Otherwise a user could hold their
 *    account in a half-erased state forever by asking once a day.
 *
 * And one that is about the *entity* rather than the service: `requestDeletion`
 * lives on the row, so `deletedAt` and `deletionReason` cannot be set apart by
 * somebody reaching past it with a repository call.
 */

function harness(options: { user?: User | null } = {}) {
  const user = options.user === undefined ? new User() : options.user;

  if (user) {
    // Defaults filled in only where the caller's row left a gap. Assigning over
    // the top would reset `deletedAt` to null on an already-erased row, and every
    // idempotency test below would then be asserting the first-request path.
    const defaults: Partial<User> = {
      id: 'u1',
      email: 'a@x.com',
      isActive: true,
      isEmailVerified: true,
      lockedAt: null,
      deletedAt: null,
    };

    for (const [key, value] of Object.entries(defaults)) {
      if ((user as unknown as Record<string, unknown>)[key] === undefined) {
        (user as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }

  const saved: User[] = [];
  const deleteKeys = vi.fn(async () => undefined);
  const forget = vi.fn(async () => undefined);
  const notify = vi.fn(async () => ({ notificationId: 'n1', queued: true }));

  const service = new UsersService(
    {
      findOne: vi.fn(async () => user),
      save: vi.fn(async (value: User) => {
        saved.push(value);

        return value;
      }),
      merge: (base: unknown, dto: unknown) => ({
        ...(base as object),
        ...(dto as object),
      }),
    } as never,
    { deleteKeys } as never,
    { getOrThrow: () => ({ authUserTtl: 60 }) } as never,
    { notify } as never,
    { forget } as never,
  );

  return { service, user, saved, deleteKeys, forget, notify };
}

describe('the entity method', () => {
  it('stamps the time itself, so a caller cannot backdate it', () => {
    // The thirty-day clock is measured from this timestamp. A caller who could set
    // it could ask for deletion and skip the grace period by claiming it was last
    // month.
    const user = new User();

    user.requestDeletion('done with it');

    expect(user.deletedAt).toBeInstanceOf(Date);
    expect(
      Math.abs(Date.now() - (user.deletedAt as Date).getTime()),
    ).toBeLessThan(5_000);
  });

  it('records the reason beside it, so the row can explain itself later', () => {
    const user = new User();

    user.requestDeletion('  no longer needed  ');

    expect(user.deletionReason).toBe('no longer needed');
  });

  it('refuses an empty reason silently rather than storing a blank', () => {
    // The hard delete removes everything else; a blank column is a row nobody can
    // explain to the person it belonged to.
    const user = new User();

    user.requestDeletion('   ');

    expect(user.deletionReason).toBe('no reason given');
  });
});

describe('the service', () => {
  it('marks the row and saves it', async () => {
    const h = harness();

    await h.service.requestDeletion(
      'u1',
      'closing my account',
      'the account owner',
    );

    expect(h.saved[0]).toMatchObject({
      deletedAt: expect.any(Date),
      deletionReason: 'closing my account',
    });
  });

  it('does not hard delete, so an operator can still reverse it', async () => {
    const h = harness();

    await h.service.requestDeletion('u1', 'x', 'the account owner');

    // There is no `remove` here at all. The row is kept for
    // `RETENTION_SOFT_DELETED_USERS_DAYS` and removed by the retention job then.
    expect(h.saved[0]?.deletedAt).toBeInstanceOf(Date);
  });

  it('stops the account authenticating now, not when its cache expires', async () => {
    // A soft delete leaves `isActive` alone, so nothing downstream would notice an
    // erased account until its cached claims ran out.
    const h = harness();

    await h.service.requestDeletion('u1', 'x', 'the account owner');

    expect(h.deleteKeys).toHaveBeenCalledWith('user:u1', 'user:u1:devices');
  });

  it('removes the notification preferences immediately', async () => {
    // Asymmetric with the row, deliberately. A channel choice is not part of the
    // person, and restoring an account should not restore "email me about this"
    // for an address that was just erased.
    const h = harness();

    await h.service.requestDeletion('u1', 'x', 'the account owner');

    expect(h.forget).toHaveBeenCalledWith('u1');
  });

  it('tells the operators, naming who asked', async () => {
    const h = harness();

    await h.service.requestDeletion('u1', 'x', 'the account owner');

    expect(h.notify).toHaveBeenCalledWith(
      'user.deleted',
      { email: 'a@x.com', actor: 'the account owner' },
      { userId: 'u1' },
    );
  });

  it('refuses an id with no row', async () => {
    const h = harness({ user: null });

    await expect(
      h.service.requestDeletion('u1', 'x', 'someone'),
    ).rejects.toThrow('User not found');
  });
});

describe('asking twice', () => {
  it('does not restart the clock', async () => {
    // Otherwise a user could hold their account in a half-erased state
    // indefinitely by requesting deletion once a day, and the promise that an
    // operator has thirty days to act would mean nothing.
    const already = new User();

    Object.assign(already, {
      id: 'u1',
      email: 'a@x.com',
      isActive: true,
      isEmailVerified: true,
      lockedAt: null,
      deletedAt: new Date('2026-01-01T00:00:00Z'),
      deletionReason: 'first request',
    });

    const second = harness({ user: already });

    await second.service.requestDeletion(
      'u1',
      'second request',
      'the account owner',
    );

    expect(second.saved).toHaveLength(0);
    expect(already.deletionReason).toBe('first request');
  });

  it('does not notify a second time', async () => {
    const already = new User();

    Object.assign(already, { id: 'u1', deletedAt: new Date() });
    const h = harness({ user: already });

    await h.service.requestDeletion('u1', 'again', 'the account owner');

    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe('when the preference removal fails', () => {
  it('does not fail the erasure', async () => {
    // The row is already marked, so throwing here would leave the caller
    // believing the erasure did not happen — and retrying it would not unmark the
    // row. These are configuration rows with no security value.
    const h = harness();
    h.forget.mockRejectedValueOnce(new Error('relation is locked'));

    await expect(
      h.service.requestDeletion('u1', 'x', 'the account owner'),
    ).resolves.toMatchObject({ deletedAt: expect.any(Date) });
  });

  it('still tells the operators', async () => {
    const h = harness();
    h.forget.mockRejectedValueOnce(new Error('relation is locked'));

    await h.service.requestDeletion('u1', 'x', 'the account owner');

    expect(h.notify).toHaveBeenCalled();
  });
});

describe('the administrative path', () => {
  it('records that an operator did it, so the row explains itself', async () => {
    // `DELETE /users/:id` is the same erasure with a different actor, and the
    // reason has to say so — a row deleted by an operator and a row deleted by its
    // owner are different events with different follow-ups.
    const h = harness();

    await h.service.softDelete('u1', 'admin@x.com');

    expect(h.saved[0]?.deletionReason).toBe('deleted by an administrator');
  });

  it('names the operator in the notification', async () => {
    const h = harness();

    await h.service.softDelete('u1', 'admin@x.com');

    expect(h.notify).toHaveBeenCalledWith(
      'user.deleted',
      { email: 'a@x.com', actor: 'admin@x.com' },
      { userId: 'u1' },
    );
  });
});
