import { BadRequestException } from '@nestjs/common';

import { describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.service.js';

/**
 * The policy is only enforced if every route that sets a password goes through it,
 * and that is a claim about call sites rather than about a service. These drive
 * the real `register()` and `resetPassword()` with a policy that refuses, so a
 * future route added without the check is visible here as a missing assertion
 * rather than as a silent hole.
 *
 * `TestableAuthService` is the same subclass `email-verification.spec.ts` uses, for
 * the same reason: it removes the response timing floor so the suite does not spend
 * a quarter of a second per call.
 */

const appConfig = {
  name: 'Example',
  env: 'test',
  url: 'https://app.example.com',
};

const USER = {
  id: 'u1',
  email: 'ada@example.com',
  firstName: 'Ada',
  isEmailVerified: false,
};

const METADATA = { deviceName: 'Firefox', ipAddress: '203.0.113.9' };

interface Harness {
  service: AuthService;
  check: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  consume: ReturnType<typeof vi.fn>;
}

interface PasswordPolicyDouble {
  check: ReturnType<typeof vi.fn>;
  policy: { minLength: number };
}

/** A policy that refuses, so the assertions can be about the refusal. */
function refusing(...reasons: string[]): PasswordPolicyDouble {
  return {
    check: vi.fn(async () => ({ ok: false, reasons })),
    policy: { minLength: 8 },
  };
}

const accepting = (): PasswordPolicyDouble => ({
  check: vi.fn(async () => ({ ok: true, reasons: [] })),
  policy: { minLength: 8 },
});

function harness(
  policy: PasswordPolicyDouble = refusing(
    'Password must be at least 12 characters',
  ),
): Harness {
  class TestableAuthService extends AuthService {
    protected override async padded<T>(response: T): Promise<T> {
      return response;
    }
  }

  const create = vi.fn(async () => ({ ...USER }));
  const consume = vi.fn(async () => undefined);

  const service = new TestableAuthService(
    {
      signAsync: vi.fn(async () => 'access-token'),
      decode: vi.fn(() => ({ iat: 1_000, exp: 1_900 })),
    } as never,
    {
      create,
      findByEmail: vi.fn(async () => null),
      findById: vi.fn(async () => USER),
      invalidateAuthCache: vi.fn(async () => undefined),
      runThenInvalidateAuthCache: vi.fn(
        async (_id: string, work: () => unknown) => work(),
      ),
    } as never,
    {
      issue: vi.fn(async () => ({
        token: 'refresh',
        record: { jti: 'sess-1' },
      })),
      findByJti: vi.fn(async () => ({ userId: 'u1', deviceId: 'd1' })),
      revokeAllByUserId: vi.fn(async () => 1),
    } as never,
    {
      register: vi.fn(async () => ({
        device: { id: 'd1', sessionsVersion: 0 },
        created: true,
      })),
      findByIdForSession: vi.fn(async () => ({ id: 'd1', sessionsVersion: 0 })),
      revokeAllByUserId: vi.fn(async () => 1),
    } as never,
    { isEnabled: vi.fn(async () => false) } as never,
    { consume } as never,
    { spendOutstandingFor: vi.fn(async () => undefined) } as never,
    {
      buildUrl: (path: string) => `${appConfig.url}${path}`,
      sendTemplate: vi.fn(async () => ({ delivered: true })),
    } as never,
    { enqueue: vi.fn(async () => undefined) } as never,
    { getOrThrow: () => appConfig } as never,
    {
      inspect: vi.fn(async () => ({
        blocked: false,
        retryAfterSeconds: 0,
        firstBlock: false,
        failures: 0,
      })),
      recordFailure: vi.fn(async () => ({
        blocked: false,
        retryAfterSeconds: 0,
        firstBlock: false,
        failures: 0,
      })),
      reset: vi.fn(async () => undefined),
    } as never,
    {
      notify: vi.fn(async () => ({ notificationId: 'n1', queued: true })),
    } as never,
    policy as never,
    // The history writer. Registration records the first entry after the row
    // exists, and these tests are not about that.
    {
      record: vi.fn(async () => undefined),
      wasUsedBefore: vi.fn(async () => false),
    } as never,
    // The permanent lockout. These tests are about what happens around sign-in,
    // not about the second lockout, so the fake records the call and does nothing.
    // `lockOnRepeatedFailures` is exercised on its own in account-lock.service.spec.
    {
      lockOnRepeatedFailures: vi.fn(async () => undefined),
    } as never,
  );

  return { service, check: policy.check, create, consume };
}

describe('the password history', () => {
  it('records the very first hash after the account exists', async () => {
    // The ordering is the point: a history row whose user does not exist is an
    // orphan the cascade cannot clean up, whereas a missing row only costs the
    // ability to reuse this one password.
    const order: string[] = [];
    const h = harness(accepting());

    h.create.mockImplementation(async () => {
      order.push('create');

      return { ...USER };
    });

    (
      h.service as never as { passwordHistory: { record: () => Promise<void> } }
    ).passwordHistory = {
      record: async () => {
        order.push('history');
      },
      wasUsedBefore: async () => false,
    } as never;

    await h.service.register(
      { email: 'ada@example.com', password: 'Correct-Horse-1' } as never,
      METADATA as never,
    );

    expect(order).toEqual(['create', 'history']);
  });

  it('records the hash rather than the password', async () => {
    const record = vi.fn(async () => undefined);
    const h = harness(accepting());
    (h.service as never as { passwordHistory: unknown }).passwordHistory = {
      record,
      wasUsedBefore: async () => false,
    };

    await h.service.register(
      { email: 'ada@example.com', password: 'Correct-Horse-1' } as never,
      METADATA as never,
    );

    expect(record).toHaveBeenCalledWith('u1', expect.any(String), 'register');
    // The obvious mistake, and one `toHaveBeenCalledWith` above would not catch:
    // `expect.any(String)` is satisfied by the password as readily as by a hash.
    expect(JSON.stringify(record.mock.calls)).not.toContain('Correct-Horse-1');
  });

  it('does not check the history at registration, because there is none', async () => {
    // The account does not exist yet, so there is nothing to have reused.
    const wasUsedBefore = vi.fn(async () => true);
    const h = harness(accepting());
    (h.service as never as { passwordHistory: unknown }).passwordHistory = {
      record: async () => undefined,
      wasUsedBefore,
    };

    await h.service.register(
      { email: 'ada@example.com', password: 'Correct-Horse-1' } as never,
      METADATA as never,
    );

    expect(wasUsedBefore).not.toHaveBeenCalled();
  });
});

describe('register', () => {
  it('refuses a password the policy rejects', async () => {
    const h = harness();

    await expect(
      h.service.register(
        { email: 'ada@example.com', password: 'short' } as never,
        METADATA as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('says which rule was broken, because "password is invalid" is unusable', async () => {
    // A form that cannot say what is wrong is a form people give up on, and the
    // reason people end up choosing `Password1!` is being told only that they were
    // wrong.
    const h = harness(
      refusing(
        'Password must be at least 12 characters',
        'Password must contain a symbol',
      ),
    );

    await expect(
      h.service.register(
        { email: 'ada@example.com', password: 'x' } as never,
        METADATA as never,
      ),
    ).rejects.toThrow(/at least 12 characters[\s\S]*contain a symbol/);
  });

  it('does not create the account when the password is refused', async () => {
    // Otherwise a rejected signup leaves a row behind that the user cannot sign in
    // to, and an email uniqueness check would then tell the next attempt that the
    // address is taken.
    const h = harness();

    await h.service
      .register(
        { email: 'ada@example.com', password: 'short' } as never,
        METADATA as never,
      )
      .catch(() => undefined);

    expect(h.create).not.toHaveBeenCalled();
  });

  it('passes through when the policy accepts', async () => {
    const h = harness(accepting());

    await expect(
      h.service.register(
        { email: 'ada@example.com', password: 'Correct-Horse-1' } as never,
        METADATA as never,
      ),
    ).resolves.toBeDefined();
  });

  it('checks the password, rather than trusting the DTO to have done it', async () => {
    // The DTO's `@MinLength(8)` is a static rule that knows nothing about the
    // configured minimum. If this call is ever removed the only thing that catches
    // it is that `check` is asserted here.
    const h = harness(accepting());

    await h.service.register(
      { email: 'ada@example.com', password: 'Correct-Horse-1' } as never,
      METADATA as never,
    );

    expect(h.check).toHaveBeenCalledWith('Correct-Horse-1');
  });
});

describe('resetPassword', () => {
  const dto = { token: 'the-token', newPassword: 'short' };

  it('refuses a password the policy rejects', async () => {
    const h = harness();

    await expect(h.service.resetPassword(dto as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('does not spend the token on a refused attempt', async () => {
    // The token is single use. Spending it on a rejected password would leave
    // somebody who mistyped their new password needing the entire reset flow again,
    // for no security gain: the token proved who they are either way.
    const h = harness();

    await h.service.resetPassword(dto as never).catch(() => undefined);

    expect(h.consume).not.toHaveBeenCalled();
  });

  it('says which rule was broken', async () => {
    const h = harness(refusing('This password has been used before.'));

    await expect(h.service.resetPassword(dto as never)).rejects.toThrow(
      /used before/,
    );
  });

  it('spends the token when the password is accepted', async () => {
    const h = harness(accepting());

    await expect(
      h.service.resetPassword({
        token: 'the-token',
        newPassword: 'Correct-Horse-1',
      } as never),
    ).resolves.toBeDefined();

    expect(h.consume).toHaveBeenCalledWith('the-token', 'Correct-Horse-1');
  });

  it('checks the new password rather than the token', async () => {
    const h = harness(accepting());

    await h.service.resetPassword({
      token: 'the-token',
      newPassword: 'Correct-Horse-1',
    } as never);

    expect(h.check).toHaveBeenCalledWith('Correct-Horse-1');
  });
});
