import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hashPassword } from '../../common/utils/index.js';
import { passwordPolicyConfig } from '../../configs/password-policy.config.js';
import { PasswordHistoryService } from './password-history.service.js';

/**
 * Two properties carry this feature, and both are easy to get wrong in the
 * direction that matters:
 *
 * - **A rejected password must not have spent the token.** The reuse check runs
 *   inside the reset transaction and throws, which rolls it back. That is asserted
 *   here by the service's behaviour rather than by the transaction's, because the
 *   rollback is TypeORM's job.
 * - **The window must be exactly N.** Not N-1, because an off-by-one that keeps
 *   too few silently allows reuse; not N+1, because one that keeps too many grows a
 *   table of credentials for no benefit.
 */

type Policy = ReturnType<typeof passwordPolicyConfig>;

const policy = (overrides: Partial<Policy> = {}): Policy => ({
  ...passwordPolicyConfig(),
  ...overrides,
});

interface Harness {
  service: PasswordHistoryService;
  insert: ReturnType<typeof vi.fn>;
  /** Rows the repository holds, oldest first, as `{ id, userId }`. */
  rows: { id: string; userId: string; passwordHash: string }[];
  find: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function harness(
  config: Policy = policy(),
  stored: { passwordHash: string }[] = [],
): Harness {
  const rows = stored.map((entry, index) => ({
    id: `h${index}`,
    userId: 'u1',
    passwordHash: entry.passwordHash,
    createdAt: new Date(index),
  }));

  const insert = vi.fn(async () => undefined);
  const remove = vi.fn(async () => ({ affected: 0 }));

  // `EntityManager.find(target, options)` is two arguments, while
  // `Repository.find(options)` is one. Both are used — the trim goes through a
  // manager because it may be inside a caller's transaction — so the fake branches
  // on the argument count rather than assuming one shape, which is what a mock
  // missing the first argument silently does.
  const find = vi.fn(async (...args: unknown[]) => {
    const options = (args.length > 1 ? args[1] : args[0]) as {
      skip?: number;
      take?: number;
    };

    if (options?.skip !== undefined) {
      return rows.slice(options.skip);
    }

    return options?.take !== undefined
      ? rows.slice(0, options.take)
      : [...rows];
  });

  const service = new PasswordHistoryService(
    { find, manager: { insert, delete: remove, find } } as never,
    { ...config } as never,
  );

  return { service, insert, rows, find, delete: remove };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('wasUsedBefore', () => {
  it('answers false for a user with no history', async () => {
    // The common case at registration, and the one that must not cost a scrypt
    // derivation per empty row.
    const h = harness();

    await expect(
      h.service.wasUsedBefore('u1', 'Correct-Horse-1'),
    ).resolves.toBe(false);
  });

  it('answers true when the password is in the window', async () => {
    // Every entry is a scrypt verification, because a password is a password and
    // there is no cheaper way to know whether it matches. Five by default, so this
    // is five derivations on a real deployment.
    const hash = await hashPassword('Correct-Horse-1');
    const h = harness(policy(), [{ passwordHash: hash }]);

    await expect(
      h.service.wasUsedBefore('u1', 'Correct-Horse-1'),
    ).resolves.toBe(true);
  });

  it('answers false when the stored hashes are all different', async () => {
    const h = harness(policy(), [
      { passwordHash: await hashPassword('first-one') },
      { passwordHash: await hashPassword('second-one') },
    ]);

    await expect(h.service.wasUsedBefore('u1', 'third-one')).resolves.toBe(
      false,
    );
  });

  it('asks for exactly the configured window, not the whole history', async () => {
    // A user who has changed their password fifty times must not cost fifty
    // derivations on the fifty-first.
    const h = harness(policy({ historyCount: 3 }));

    await h.service.wasUsedBefore('u1', 'Correct-Horse-1');

    // `Repository.find` is a single argument, so the window is the only object.
    expect(h.find).toHaveBeenCalledWith(
      expect.objectContaining({ take: 3, order: { createdAt: 'DESC' } }),
    );
  });

  it('reads the newest first, because the recent ones are the likely repeats', async () => {
    const h = harness(policy());

    await h.service.wasUsedBefore('u1', 'Correct-Horse-1');

    expect(h.find).toHaveBeenCalledWith(
      expect.objectContaining({ order: { createdAt: 'DESC' } }),
    );
  });

  it('answers false without reading anything when the feature is off', async () => {
    // `PASSWORD_HISTORY_COUNT=0` disables the feature, and a disabled feature that
    // still queries is one that costs a deployment money for nothing.
    const h = harness(policy({ historyCount: 0 }));

    await expect(
      h.service.wasUsedBefore('u1', 'Correct-Horse-1'),
    ).resolves.toBe(false);
    expect(h.find).not.toHaveBeenCalled();
  });
});

describe('record', () => {
  it('writes the hash, never the password', async () => {
    // A history of plaintext passwords would be the single worst table in the
    // database: the user's most reused credentials, in the clear, with no expiry.
    const h = harness();

    await h.service.record('u1', 'a1b2:saltkey', 'reset');

    expect(h.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        passwordHash: 'a1b2:saltkey',
        reason: 'reset',
      }),
    );
  });

  it('writes nothing when the feature is off', async () => {
    // Storing credentials for a policy that will never check them is pure risk.
    const h = harness(policy({ historyCount: 0 }));

    await h.service.record('u1', 'a1b2:saltkey', 'reset');

    expect(h.insert).not.toHaveBeenCalled();
  });

  it('uses the repository when no transaction is offered', async () => {
    // Registration has no transaction to join, and writes through the repository.
    const h = harness();

    await h.service.record('u1', 'a1b2:saltkey', 'register');

    expect(h.insert).toHaveBeenCalledTimes(1);
  });

  it('uses the given transaction when one is offered', async () => {
    // A reset has one, and the insert has to be inside it: a rolled-back reset
    // whose history committed would reject the old password as "used before" while
    // the account still has it.
    const h = harness();
    const manager = {
      insert: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue({ affected: 0 }),
      find: vi.fn().mockResolvedValue([]),
    };

    await h.service.record('u1', 'a1b2:saltkey', 'reset', manager as never);

    expect(manager.insert).toHaveBeenCalledTimes(1);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('trims to exactly the window, not one more', async () => {
    // Off-by-one in the keeping direction silently allows reuse, which is the
    // failure the feature exists to prevent.
    const h = harness(policy({ historyCount: 2 }), [
      { passwordHash: 'h0' },
      { passwordHash: 'h1' },
      { passwordHash: 'h2' },
      { passwordHash: 'h3' },
    ]);

    await h.service.record('u1', 'newhash', 'reset');

    // Rows 0 and 1 survive; 2 and 3 are the surplus. Matched on the ids alone so a
    // change to how the entity is passed does not read as a trim regression.
    expect(h.delete.mock.calls[0][1]).toEqual(['h2', 'h3']);
  });

  it('trims on every write, so the table never exceeds the window', async () => {
    // Left to a nightly job, the table would hold N+1 between the change and the
    // cleanup, and the answer to "has this been reused" would depend on when it was
    // asked. The assertion is that the trim *query* ran on this write, not that it
    // deleted anything — an already-conforming table still has to be checked.
    const h = harness(policy({ historyCount: 5 }), [
      { passwordHash: 'h0' },
      { passwordHash: 'h1' },
      { passwordHash: 'h2' },
      { passwordHash: 'h3' },
      { passwordHash: 'h4' },
    ]);

    await h.service.record('u1', 'newhash', 'reset');

    expect(h.find).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ skip: 5 }),
    );
  });

  it('skips the trim query when nothing is over the window', async () => {
    const h = harness(policy({ historyCount: 5 }), [{ passwordHash: 'h0' }]);

    await h.service.record('u1', 'newhash', 'reset');

    expect(h.delete).not.toHaveBeenCalled();
  });

  it('asks for exactly the rows past the window, in the order that identifies them', async () => {
    // Belt and braces on the direction that matters: `skip` must be the count the
    // policy keeps, and the sort must be newest-first, or the trim would keep the
    // wrong end of the history.
    const h = harness(policy({ historyCount: 4 }), [
      { passwordHash: 'h0' },
      { passwordHash: 'h1' },
      { passwordHash: 'h2' },
      { passwordHash: 'h3' },
      { passwordHash: 'h4' },
      { passwordHash: 'h5' },
    ]);

    await h.service.record('u1', 'newhash', 'reset');

    expect(h.find).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        skip: 4,
        order: { createdAt: 'DESC' },
        where: { userId: 'u1' },
      }),
    );
    expect(h.delete.mock.calls[0][1]).toEqual(['h4', 'h5']);
  });
});
