import { UnauthorizedException } from '@nestjs/common';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RefreshTokenRevokedReason } from './enums/index.js';
import { AuthService } from './auth.service.js';

/**
 * A rotation replaces one refresh token with another, which changes the session id
 * the access token names. Without anything recorded, the access token the caller
 * was already holding keeps working for the rest of its fifteen minutes, so a
 * rotation revokes nothing the caller can observe.
 *
 * The property under test is the ordering, because both orders "work" and only one
 * of them is right. Recording the revocation inside the transaction would kill the
 * access token of a refresh that then rolled back, leaving a client with a live
 * refresh token and no live access token.
 */

const USER = {
  id: 'u1',
  email: 'a@x.com',
  password: '$2b$10$hash',
  firstName: null,
  lastName: null,
  role: 'user',
  isActive: true,
  isManager: false,
  sessionsVersion: 0,
  isEmailVerified: true,
  emailVerifiedAt: null,
  lastLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

const DEVICE = { id: 'd1', userId: 'u1', sessionsVersion: 0 };

/** What the rotation found, and what it issued. */
function harness(
  options: {
    /**
     * Why the stored token is already revoked, if it is.
     *
     * `Rotated` is the reuse signal and drops the whole account. `Logout` is a
     * deliberate sign-out and is treated as merely invalid, which is the difference
     * the rotation code draws and the reason this is a parameter rather than a
     * boolean.
     */
    revokedReason?: RefreshTokenRevokedReason | null;
    expired?: boolean;
  } = {},
) {
  const order: string[] = [];

  const current = {
    jti: 'jti-old',
    id: 'row-old',
    userId: 'u1',
    deviceId: 'd1',
    revokedAt:
      options.revokedReason === undefined || options.revokedReason === null
        ? null
        : new Date(),
    revokedReason: options.revokedReason ?? null,
    expiresAt: new Date(Date.now() + (options.expired ? -1000 : 86_400_000)),
  };

  const issued = {
    jti: 'jti-new',
    id: 'row-new',
    userId: 'u1',
    deviceId: 'd1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 86_400_000),
  };

  const manager = {
    findOne: vi.fn().mockResolvedValue(current),
    update: vi.fn().mockResolvedValue({ affected: 1 }),
  };

  const refreshTokenService = {
    verify: vi.fn().mockReturnValue({ sub: 'u1', jti: 'jti-old' }),
    findByJti: vi.fn().mockResolvedValue(current),
    revokeByJti: vi.fn().mockResolvedValue(undefined),
    revokeAllByUserId: vi.fn().mockResolvedValue(2),
    runInTransaction: vi.fn(
      async (handler: (m: unknown) => Promise<unknown>) => {
        const result = await handler(manager);
        // Stands in for the commit. Anything recorded before this point describes a
        // rotation that had not happened yet.
        order.push('commit');

        return result;
      },
    ),
    issue: vi.fn().mockResolvedValue({
      token: 'refresh-token-new',
      record: issued,
    }),
    isSessionRevoked: vi.fn().mockResolvedValue(false),
    markSessionRevoked: vi.fn(async (sessionId: string) => {
      order.push(`mark:${sessionId}`);
    }),
  };

  const deviceService = {
    findByIdForSession: vi.fn().mockResolvedValue(DEVICE),
    revokeAllByUserId: vi.fn().mockResolvedValue(1),
    register: vi.fn().mockResolvedValue(DEVICE),
  };

  const jwtService = {
    signAsync: vi.fn().mockResolvedValue('signed-access-token'),
    decode: vi.fn().mockReturnValue({ iat: 1_000, exp: 1_900 }),
  };

  const usersService = {
    findById: vi.fn().mockResolvedValue(USER),
  };

  const service = new AuthService(
    jwtService as never,
    usersService as never,
    refreshTokenService as never,
    deviceService as never,
    { isEnabled: vi.fn().mockResolvedValue(false) } as never,
    { consume: vi.fn() } as never,
    { spendOutstandingFor: vi.fn() } as never,
    {} as never,
    { enqueue: vi.fn() } as never,
    { getOrThrow: () => ({ name: 'Example', env: 'test' }) } as never,
    {
      inspect: vi.fn().mockResolvedValue({
        blocked: false,
        retryAfterSeconds: 0,
        firstBlock: false,
      }),
    } as never,
  );

  return { service, refreshTokenService, deviceService, jwtService, order };
}

const dto = { refreshToken: 'refresh-token-old' };
const metadata = {
  ipAddress: '1.1.1.1',
  userAgent: 'vitest',
  deviceName: null,
};

/** The payload of the access token the refresh produced. */
function signedPayload(jwtService: { signAsync: ReturnType<typeof vi.fn> }) {
  return jwtService.signAsync.mock.calls[0][0] as Record<string, unknown>;
}

describe('a refresh token rotation', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  it('records the superseded session as revoked', async () => {
    await h.service.refresh(dto as never, metadata as never);

    // The old access token named this session. Recording it is what stops that
    // token working until it expires on its own.
    expect(h.refreshTokenService.markSessionRevoked).toHaveBeenCalledWith(
      'jti-old',
    );
  });

  it('mints the new token against the new session', async () => {
    await h.service.refresh(dto as never, metadata as never);

    const payload = signedPayload(h.jwtService);

    expect(payload.sid).toBe('jti-new');
  });

  it('records the revocation only after the rotation commits', async () => {
    // The whole point. Recorded before the commit, it would kill the access token
    // of a rotation that then rolled back, and the client would be left holding a
    // working refresh token and no working access token.
    await h.service.refresh(dto as never, metadata as never);

    expect(h.order).toEqual(['commit', 'mark:jti-old']);
  });

  it('leaves the new session un-revoked', async () => {
    await h.service.refresh(dto as never, metadata as never);

    expect(h.refreshTokenService.markSessionRevoked).not.toHaveBeenCalledWith(
      'jti-new',
    );
  });

  it('still names the device the access token needs', async () => {
    await h.service.refresh(dto as never, metadata as never);

    const payload = signedPayload(h.jwtService);

    expect(payload.did).toBe('d1');
    expect(payload.dv).toBe(0);
  });
});

describe('a rotation that fails', () => {
  it('treats a token revoked by a logout as merely invalid', async () => {
    // Signing out is not a compromise, so a replayed logout token must not be read
    // as a leak and take the whole account down with it.
    const h = harness({ revokedReason: RefreshTokenRevokedReason.Logout });

    await expect(
      h.service.refresh(dto as never, metadata as never),
    ).rejects.toThrow('Invalid refresh token');

    expect(h.refreshTokenService.revokeAllByUserId).not.toHaveBeenCalled();
    expect(h.refreshTokenService.markSessionRevoked).not.toHaveBeenCalled();
  });

  it('records nothing when the rotation is refused as reuse', async () => {
    // The reuse path drops every session of the account already. Recording one on
    // top would be redundant, and the caller is about to be rejected anyway.
    const h = harness({
      revokedReason: RefreshTokenRevokedReason.Rotated,
    });

    await expect(
      h.service.refresh(dto as never, metadata as never),
    ).rejects.toThrow('Refresh token reuse detected');

    expect(h.refreshTokenService.markSessionRevoked).not.toHaveBeenCalled();
  });

  it('records nothing when the session has expired', async () => {
    const h = harness({ expired: true });

    await expect(
      h.service.refresh(dto as never, metadata as never),
    ).rejects.toThrow(UnauthorizedException);

    expect(h.refreshTokenService.markSessionRevoked).not.toHaveBeenCalled();
  });

  it('records nothing when the rotation throws', async () => {
    const h = harness();
    h.refreshTokenService.issue.mockRejectedValueOnce(new Error('deadlock'));

    await expect(
      h.service.refresh(dto as never, metadata as never),
    ).rejects.toThrow('deadlock');

    // Nothing was committed, so there is no superseded session to record.
    expect(h.refreshTokenService.markSessionRevoked).not.toHaveBeenCalled();
  });

  it('still records the revocation when the caller cannot be issued a token', async () => {
    // The rotation committed, so the old access token is superseded whether or not
    // this caller ends up with a new one. Ordering it the other way would leave a
    // committed rotation with nothing recorded.
    const h = harness();
    h.deviceService.findByIdForSession.mockResolvedValueOnce(null);

    await expect(
      h.service.refresh(dto as never, metadata as never),
    ).rejects.toThrow(UnauthorizedException);

    expect(h.refreshTokenService.markSessionRevoked).toHaveBeenCalledWith(
      'jti-old',
    );
  });
});

describe('the reuse signal', () => {
  it('drops every refresh token of the account', async () => {
    const h = harness({
      revokedReason: RefreshTokenRevokedReason.Rotated,
    });

    await expect(
      h.service.refresh(dto as never, metadata as never),
    ).rejects.toThrow('Refresh token reuse detected');

    expect(h.refreshTokenService.revokeAllByUserId).toHaveBeenCalledWith(
      'u1',
      RefreshTokenRevokedReason.ReuseDetected,
      expect.anything(),
    );
  });
});
