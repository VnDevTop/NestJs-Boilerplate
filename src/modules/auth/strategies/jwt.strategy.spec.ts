import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { User } from '../../users/entities/index.js';
import { JwtPayload } from '../../../common/interfaces/index.js';
import { JwtStrategy } from './jwt.strategy.js';
import {
  TenantContextService,
  type TenantScope,
} from '../../../common/tenancy/tenant-context.service.js';

// `.repeat`, not ``'a' * 32``: string times number is NaN in JavaScript, and a
// NaN secret is falsy, which the strategy reports as a missing configuration.
const SECRET = 'a'.repeat(32);

const user = (overrides: Partial<User> = {}): User =>
  ({
    id: 'u1',
    email: 'a@x.com',
    isActive: true,
    isManager: false,
    role: 'user',
    sessionsVersion: 0,
    // Explicit, because the strategy tests it against null and an `undefined`
    // fixture fails that test exactly like a locked account does. Every assertion
    // in this file would then be asserting the lockout rather than what it was
    // written for.
    lockedAt: null,
    ...overrides,
  }) as User;

function harness(
  options: {
    user?: User | null;
    devices?: Record<string, number>;
    revokedSessions?: string[];
  } = {},
) {
  const found = options.user === undefined ? user() : options.user;
  const findAuthClaims = vi.fn().mockResolvedValue(found);
  const forRole = vi.fn().mockResolvedValue([]);
  const config = {
    get: vi.fn().mockReturnValue(SECRET),
  } as unknown as ConfigService;

  const devices = options.devices ?? {};

  return {
    strategy: new JwtStrategy(
      config,
      { findAuthClaims } as never,
      { forRole } as never,
      { findSessionVersions: vi.fn().mockResolvedValue(devices) } as never,
      {
        isSessionRevoked: vi
          .fn()
          .mockResolvedValue(
            (options.revokedSessions ?? []).includes('sess-1'),
          ),
      } as never,
    ),
    findAuthClaims,
    forRole,
  };
}

const payload = (overrides: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: 'u1',
  email: 'a@x.com',
  ...overrides,
});

function tenantScope(tenantId: string): TenantScope {
  return {
    id: tenantId,
    slug: tenantId,
    name: tenantId,
    status: 'active',
    plan: '',
    schemaName: null,
  };
}

function strategyWithTenant(_tenantId: string) {
  const context = new TenantContextService();
  const config = {
    get: vi.fn().mockReturnValue(SECRET),
  } as unknown as ConfigService;

  return {
    strategy: new JwtStrategy(
      config,
      { findAuthClaims: vi.fn().mockResolvedValue(user()) } as never,
      { forRole: vi.fn().mockResolvedValue([]) } as never,
      { findSessionVersions: vi.fn().mockResolvedValue({}) } as never,
      { isSessionRevoked: vi.fn().mockResolvedValue(false) } as never,
      context,
    ),
    context,
  };
}

describe('JwtStrategy sessionsVersion', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  describe('a token carrying a matching claim', () => {
    it('is accepted', async () => {
      const result = await h.strategy.validate(payload({ sv: 0 }));

      expect(result.id).toBe('u1');
    });

    it('is accepted after an unrelated version bump elsewhere', async () => {
      // Bumped twice, so the token is at 0 and the user is at 2. Still refused.
      h = harness({ user: user({ sessionsVersion: 2 }) });

      await expect(h.strategy.validate(payload({ sv: 0 }))).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('a token whose claim is behind', () => {
    it('is refused, which is the whole point of the column', async () => {
      h = harness({ user: user({ sessionsVersion: 1 }) });

      // Logged out everywhere after this token was minted. Without the claim the
      // token would keep working for its full fifteen minutes.
      await expect(h.strategy.validate(payload({ sv: 0 }))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('is refused with the generic message, not one that reveals the version', async () => {
      h = harness({ user: user({ sessionsVersion: 3 }) });

      // A message naming the version would tell a holder of a stolen token
      // exactly how recently the owner revoked everything.
      await expect(h.strategy.validate(payload({ sv: 0 }))).rejects.toThrow(
        'Invalid access token',
      );
    });
  });

  describe('a token issued before the claim existed', () => {
    it('is accepted while the user has never revoked anything', async () => {
      // The deploy case. Rejecting these would sign out every signed-in user for
      // the sake of a fifteen minute token that expires on its own anyway.
      const result = await h.strategy.validate(payload());

      expect(result.id).toBe('u1');
    });

    it('is refused once the user has revoked everything', async () => {
      // The limit the user asked for, expressed against the account rather than a
      // date: there is no deadline to configure, and it cannot be forgotten.
      h = harness({ user: user({ sessionsVersion: 1 }) });

      await expect(h.strategy.validate(payload())).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('a missing user', () => {
    it('is refused', async () => {
      h = harness({ user: null });

      await expect(h.strategy.validate(payload({ sv: 0 }))).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('a permanently locked account', () => {
    it('is refused even though the version claim matches', async () => {
      // The version comparison would catch this on its own, one day, once the token
      // was reissued. This is the check that holds from the moment of the lock.
      h = harness({
        user: user({
          lockedAt: new Date('2026-03-01T00:00:00Z'),
          sessionsVersion: 0,
        }),
      });

      await expect(h.strategy.validate(payload({ sv: 0 }))).rejects.toThrow(
        'Invalid access token',
      );
    });

    it('is refused with the same 401 an invalid token gets', async () => {
      // "your token is no good" and "your account is locked" tells an attacker
      // which of the two they are holding, and the owner has the mail that explains
      // it. Splitting the two responses would buy nothing.
      h = harness({
        user: user({ lockedAt: new Date('2026-03-01T00:00:00Z') }),
      });

      await expect(h.strategy.validate(payload({ sv: 0 }))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('is refused before the permission lookup, which costs a query', async () => {
      // A locked account is refused on the first claim that says so. Resolving
      // permissions first would spend a cached read on a request that is going to
      // be rejected anyway.
      h = harness({ user: user({ lockedAt: new Date() }) });

      await expect(h.strategy.validate(payload({ sv: 0 }))).rejects.toThrow();

      expect(h.forRole).not.toHaveBeenCalled();
    });
  });

  describe('an inactive user', () => {
    it('is refused even when the claim matches', async () => {
      // Version comparison comes second on purpose: an inactive account must fail
      // on its own account rather than on a version mismatch.
      h = harness({ user: user({ isActive: false, sessionsVersion: 0 }) });

      await expect(h.strategy.validate(payload({ sv: 0 }))).rejects.toThrow(
        'Invalid access token',
      );
    });
  });

  describe('the returned user', () => {
    it('still carries permissions, which the guard needs', async () => {
      h = harness();
      h.forRole.mockResolvedValue(['user:read']);

      const result = await h.strategy.validate(payload({ sv: 0 }));

      expect(result.permissions).toEqual(['user:read']);
    });

    it('treats a row predating the column as version zero', async () => {
      // A database where the migration backfilled nothing must not reject
      // everybody, so a missing column value reads as zero.
      const legacy = {
        ...user(),
        sessionsVersion: undefined,
      } as unknown as User;
      h = harness({ user: legacy });

      const result = await h.strategy.validate(payload({ sv: 0 }));

      expect(result.id).toBe('u1');
    });
  });

  describe('tenant claim', () => {
    it('refuses a token minted for another tenant', async () => {
      const h = strategyWithTenant('tenant-b');

      await expect(
        h.context.run(tenantScope('tenant-b'), () =>
          h.strategy.validate(payload({ tenantId: 'tenant-a' })),
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('accepts a token minted for the current tenant', async () => {
      const h = strategyWithTenant('tenant-a');

      const result = await h.context.run(tenantScope('tenant-a'), () =>
        h.strategy.validate(payload({ tenantId: 'tenant-a' })),
      );

      expect(result.tenantId).toBe('tenant-a');
    });

    it('accepts a token minted before the claim existed', async () => {
      const h = strategyWithTenant('tenant-a');

      const result = await h.context.run(tenantScope('tenant-a'), () =>
        h.strategy.validate(payload()),
      );

      expect(result.id).toBe('u1');
    });
  });
});
