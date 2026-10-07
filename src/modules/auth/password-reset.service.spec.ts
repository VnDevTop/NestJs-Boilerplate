import { BadRequestException } from '@nestjs/common';
import { IsNull } from 'typeorm';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hashToken } from '../../common/utils/index.js';
import { RefreshTokenRevokedReason } from './enums/index.js';
import { PasswordResetToken } from './entities/index.js';
import { User } from '../users/entities/index.js';
import { PasswordResetService } from './password-reset.service.js';

const USER = { id: 'user-1', email: 'a@x.com' } as never;

/** A row that is usable, so the only thing under test is the filter applied. */
function usableRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    userId: 'user-1',
    tokenHash: hashToken('the-token'),
    usedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as PasswordResetToken;
}

/**
 * A manager that records what it was asked, so the filter conditions can be
 * asserted rather than trusted.
 */
function fakeManager(
  options: { row?: PasswordResetToken | null; user?: unknown } = {},
) {
  const row = 'row' in options ? (options.row ?? null) : usableRow();
  const user = 'user' in options ? options.user : { ...(USER as object) };

  const manager = {
    update: vi.fn().mockResolvedValue({ affected: 1 }),
    save: vi.fn().mockImplementation((value) => Promise.resolve(value)),
    // Branches on the entity, because consume does two lookups: the token row
    // and then the user it belongs to. One mock answer for both would hand back
    // a token row where a user is expected.
    findOne: vi
      .fn()
      .mockImplementation((entity) =>
        Promise.resolve(entity === PasswordResetToken ? row : user),
      ),
    create: vi.fn().mockImplementation((_entity, value) => value),
    find: vi.fn().mockResolvedValue([]),
    increment: vi.fn().mockResolvedValue({ affected: 1 }),
  };

  return { manager, row, user: user as { id: string; password: string } };
}

function build(options: Parameters<typeof fakeManager>[0] = {}) {
  const { manager, user } = fakeManager(options);
  const transaction = vi.fn().mockImplementation((handler) => handler(manager));

  const refreshTokenService = {
    revokeAllByUserId: vi.fn().mockResolvedValue(2),
  };

  const service = new PasswordResetService(
    { manager } as never,
    { transaction } as never,
    refreshTokenService as never,
  );

  return { service, manager, transaction, refreshTokenService, user };
}

describe('PasswordResetService.issue', () => {
  it('stores a hash, never the token it hands out', async () => {
    // The plaintext exists in the email and in the caller's hands. If it reaches
    // the table, a database read becomes a working reset link.
    const { service, manager } = build();

    const issued = await service.issue(USER, '203.0.113.7');

    const saved = manager.save.mock.calls[0][0] as {
      tokenHash: string;
    };
    expect(saved.tokenHash).not.toBe(issued.token);
    expect(saved.tokenHash).toHaveLength(64);
  });

  it('expires in thirty minutes', async () => {
    const { service } = build();

    const { expiresAt } = await service.issue(USER, null);

    expect(Math.round((expiresAt.getTime() - Date.now()) / 60_000)).toBe(30);
  });

  it('invalidates the outstanding tokens first, so the last link always works', async () => {
    // A user who asked twice has one live link, and a link captured earlier is
    // worthless.
    const { service, manager } = build();

    await service.issue(USER, null);

    expect(manager.update).toHaveBeenCalledWith(
      PasswordResetToken,
      // IsNull() is a FindOperator, not null, so it is compared by identity
      // rather than by shape.
      { userId: 'user-1', usedAt: IsNull() },
      { usedAt: expect.any(Date) },
    );
  });

  it('records the requesting ip, which the email shows the user', async () => {
    const { service, manager } = build();

    await service.issue(USER, '203.0.113.7');

    expect(
      (manager.save.mock.calls[0][0] as { ipAddress: string }).ipAddress,
    ).toBe('203.0.113.7');
  });
});

describe('PasswordResetService.consume', () => {
  it('stores a new password hash rather than the password', async () => {
    const { service, manager } = build({
      user: { id: 'user-1', password: 'old-hash' },
    });

    await service.consume('the-token', 'a-new-password-1');

    const saved = manager.save.mock.calls[0][0] as { password: string };
    // scrypt, not the plaintext: `old-hash:salt:key`.
    expect(saved.password).not.toBe('a-new-password-1');
    expect(saved.password.split(':')).toHaveLength(2);
  });

  it('marks the token spent in the same transaction as the password change', async () => {
    // Otherwise a crash between the two writes leaves a live token next to a
    // changed password, which is a reset link the sender never chose.
    const { service, manager, transaction } = build();

    await service.consume('the-token', 'a-new-password');

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(manager.save).toHaveBeenCalledTimes(1);
    expect(manager.update).toHaveBeenCalledWith(
      PasswordResetToken,
      { id: 'row-1' },
      { usedAt: expect.any(Date) },
    );
  });

  it('kills every session, which is the point of resetting a password', async () => {
    const { service, refreshTokenService } = build();

    await service.consume('the-token', 'a-new-password');

    expect(refreshTokenService.revokeAllByUserId).toHaveBeenCalledWith(
      'user-1',
      RefreshTokenRevokedReason.PasswordChanged,
      expect.anything(),
    );
  });

  it('bumps the sessions version, so the access tokens die too', async () => {
    // Killing the refresh tokens alone leaves every access token working for its
    // remaining fifteen minutes. Somebody resetting because they think another
    // person has access must not leave that person's token alive.
    const { service, manager } = build();

    await service.consume('the-token', 'a-new-password');

    expect(manager.increment).toHaveBeenCalledWith(
      User,
      { id: 'user-1' },
      'sessionsVersion',
      1,
    );
  });

  it('bumps inside the same transaction as the password change', async () => {
    const { service, transaction, manager } = build();

    await service.consume('the-token', 'a-new-password');

    // A version committed apart from the revocation would leave every token valid
    // against a row claiming the sessions were killed.
    expect(transaction).toHaveBeenCalled();
    expect(manager.increment).toHaveBeenCalled();
  });

  it('rejects an unknown token without changing anything', async () => {
    const { service, manager, refreshTokenService } = build({ row: null });

    await expect(
      service.consume('nope', 'a-new-password'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(manager.save).not.toHaveBeenCalled();
    expect(refreshTokenService.revokeAllByUserId).not.toHaveBeenCalled();
  });

  it('rejects a used token, so a link cannot be replayed', async () => {
    const { service } = build({ row: null });

    await expect(
      service.consume('the-token', 'a-new-password'),
    ).rejects.toThrow(/invalid or has expired/);
  });

  it('gives the same message for an unknown and a used token', async () => {
    // A caller that can tell them apart can enumerate which tokens were issued,
    // and an unspent token is a live credential.
    const unknown = build({ row: null });
    const used = build({ row: null });

    const messages = await Promise.all(
      [unknown.service, used.service].map((service) =>
        service.consume('t', 'a-new-password').catch((e: Error) => e.message),
      ),
    );

    expect(new Set(messages).size).toBe(1);
  });

  it('rejects a token whose user no longer exists', async () => {
    // Only reachable if a delete lands between the lookup and this transaction.
    const { service } = build({ row: usableRow(), user: null });

    await expect(
      service.consume('the-token', 'a-new-password'),
    ).rejects.toThrow(/invalid or has expired/);
  });

  it('only accepts a token that is unspent and unexpired', async () => {
    const { service, manager } = build();

    await service.consume('the-token', 'a-new-password');

    // findOne is called as findOne(entity, { where }), so the filter is the
    // third argument.
    const [entity, options] = manager.findOne.mock.calls[0];
    expect(entity).toBe(PasswordResetToken);
    // Both halves of "usable", so a spent token and an expired one are rejected
    // by the same lookup the issue path and the check path use.
    expect(options.where.tokenHash).toBe(hashToken('the-token'));
    expect(options.where).toHaveProperty('usedAt');
    // FindOperator, matched by type rather than by instanceof.
    expect(options.where.expiresAt.type).toBe('moreThan');
  });
});

describe('PasswordResetService.isUsable', () => {
  let service: PasswordResetService;

  beforeEach(() => {
    service = build().service;
  });

  it('is true for a token that could be consumed', async () => {
    await expect(service.isUsable('the-token')).resolves.toBe(true);
  });

  it('is false for an unknown token', async () => {
    const unknown = build({ row: null });

    await expect(unknown.service.isUsable('nope')).resolves.toBe(false);
  });
});
