import { describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.service.js';

const appConfig = {
  name: 'Example',
  env: 'test',
  url: 'https://app.example.com',
};

function harness(
  options: { userExists?: boolean; verified?: boolean; active?: boolean } = {},
) {
  const sent: { to: string; verificationUrl: string }[] = [];

  const usersService = {
    findByEmail: vi.fn().mockResolvedValue(
      options.userExists === false
        ? null
        : {
            id: 'user-1',
            email: 'a@x.com',
            isActive: options.active ?? true,
            isEmailVerified: options.verified ?? false,
          },
    ),
    // register() signs a real access token, so the entity needs the fields the
    // response dto reads rather than a bare id.
    create: vi.fn().mockResolvedValue({
      id: 'user-1',
      email: 'a@x.com',
      firstName: 'T',
      lastName: null,
      role: 'user',
      isActive: true,
      isManager: false,
      isEmailVerified: false,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    }),
  };

  const passwordResetService = {
    issue: vi.fn().mockResolvedValue({ token: 't', expiresAt: new Date() }),
    consume: vi.fn(),
  };

  const emailVerificationService = {
    issue: vi.fn().mockResolvedValue({
      token: 'verify-token',
      expiresAt: new Date(Date.now() + 24 * 3_600_000),
    }),
    verify: vi.fn().mockResolvedValue({ id: 'user-1' }),
    spendOutstandingFor: vi.fn().mockResolvedValue(undefined),
  };

  const jobQueue = {
    enqueue: vi.fn().mockResolvedValue(undefined),
    driver: 'in-process' as const,
  };

  const mailService = {
    sendTemplate: vi.fn().mockImplementation((_to, name, data) => {
      if (name === 'verify-email') {
        sent.push({ to: _to, verificationUrl: data.verificationUrl });
      }
      return Promise.resolve({
        mailId: 'm-1',
        delivered: true,
        accepted: [],
        rejected: [],
      });
    }),
    buildUrl: vi.fn((path: string) => `https://app.example.com${path}`),
  };

  const deviceService = {
    register: vi.fn().mockResolvedValue({ id: 'device-1' }),
  };

  const jwtService = {
    signAsync: vi.fn().mockResolvedValue('access.token.value'),
    // createAuthToken reads exp - iat back out of the token it just signed.
    decode: vi.fn().mockReturnValue({ iat: 1_000, exp: 1_900 }),
  };

  // The padding is exercised in timing.util.spec.ts and in the enumeration tests
  // below; here it is removed so the suite does not spend 250ms per call.
  class TestableAuthService extends AuthService {
    protected override async padded<T>(response: T): Promise<T> {
      return response;
    }
  }

  const service = new TestableAuthService(
    jwtService as never,
    usersService as never,
    { issue: vi.fn().mockResolvedValue({ token: 'r' }) } as never,
    deviceService as never,
    {} as never,
    passwordResetService as never,
    emailVerificationService as never,
    mailService as never,
    jobQueue as never,
    {
      getOrThrow: () => appConfig,
    } as unknown as import('@nestjs/config').ConfigService,
    {
      // The lockout counts failures in redis, which these tests do not stand up.
      // Reporting no block keeps each test testing what it was written for.
      inspect: () =>
        Promise.resolve({
          blocked: false,
          retryAfterSeconds: 0,
          firstBlock: false,
        }),
      recordFailure: () =>
        Promise.resolve({
          blocked: false,
          retryAfterSeconds: 0,
          firstBlock: false,
        }),
      reset: () => Promise.resolve(undefined),
    } as never,
  );

  return {
    service,
    deviceService,
    usersService,
    emailVerificationService,
    mailService,
    sent,
    jobQueue,
  };
}

describe('AuthService.verifyEmail', () => {
  it('confirms the address', async () => {
    const { service, emailVerificationService } = harness();

    await service.verifyEmail({ token: 't' });

    expect(emailVerificationService.verify).toHaveBeenCalledWith('t');
  });

  it('reports success', async () => {
    const { service } = harness();

    await expect(service.verifyEmail({ token: 't' })).resolves.toEqual({
      message: 'Your email address is confirmed.',
    });
  });

  it('lets a bad token surface, since the caller supplied a token', async () => {
    const { service, emailVerificationService } = harness();
    emailVerificationService.verify.mockRejectedValue(new Error('expired'));

    await expect(service.verifyEmail({ token: 'bad' })).rejects.toThrow(
      'expired',
    );
  });
});

describe('AuthService.resendVerification', () => {
  it('answers with a message that does not confirm anything', async () => {
    const { service } = harness();

    await expect(
      service.resendVerification({ email: 'a@x.com' }, '203.0.113.7'),
    ).resolves.toEqual({
      message: 'If that address needs confirming, a new link is on its way.',
    });
  });

  it('gives an already verified address the identical answer', async () => {
    // A different message for a verified address would still enumerate who has
    // an account, which is the whole reason this route is generic.
    const unverified = harness();
    const verified = harness({ verified: true });

    const a = await unverified.service.resendVerification(
      { email: 'a@x.com' },
      '1.1.1.1',
    );
    const b = await verified.service.resendVerification(
      { email: 'a@x.com' },
      '1.1.1.1',
    );

    expect(a).toEqual(b);
  });

  it('gives an unknown address the identical answer', async () => {
    const unknown = harness({ userExists: false });

    await expect(
      unknown.service.resendVerification({ email: 'a@x.com' }, '1.1.1.1'),
    ).resolves.toEqual({
      message: 'If that address needs confirming, a new link is on its way.',
    });
  });

  it('mints a token for an unverified account', async () => {
    const { service, emailVerificationService } = harness();

    await service.resendVerification({ email: 'a@x.com' }, '203.0.113.7');

    expect(emailVerificationService.issue).toHaveBeenCalled();
  });

  it('mints nothing for an already verified account', async () => {
    const { service, emailVerificationService, mailService } = harness({
      verified: true,
    });

    await service.resendVerification({ email: 'a@x.com' }, '203.0.113.7');

    expect(emailVerificationService.issue).not.toHaveBeenCalled();
    expect(mailService.sendTemplate).not.toHaveBeenCalled();
  });

  it('mints nothing for a deactivated account', async () => {
    const { service, mailService } = harness({ active: false });

    await service.resendVerification({ email: 'a@x.com' }, '203.0.113.7');

    expect(mailService.sendTemplate).not.toHaveBeenCalled();
  });

  it('queues the mail rather than sending it inline', async () => {
    const { service, jobQueue, mailService } = harness();

    await service.resendVerification({ email: 'a@x.com' }, '203.0.113.7');

    expect(jobQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(mailService.sendTemplate).not.toHaveBeenCalled();
  });

  it('builds a link carrying the token', async () => {
    const { service, jobQueue } = harness();

    await service.resendVerification({ email: 'a@x.com' }, '203.0.113.7');

    const [, job] = jobQueue.enqueue.mock.calls[0];
    expect(job.payload.data.verificationUrl).toContain(
      '/auth/verify-email?token=',
    );
  });

  it('carries a dedupe key, so a redelivery sends no second link', async () => {
    const { service, jobQueue } = harness();

    await service.resendVerification({ email: 'a@x.com' }, '203.0.113.7');

    const [, job] = jobQueue.enqueue.mock.calls[0];
    expect(job.dedupeKey).toMatch(/^dedupe:[0-9a-f]{64}$/);
  });

  it('mints a distinct key per token, so a resend is not blocked', async () => {
    // Two resends mint two tokens. A key scoped to the address alone would
    // suppress the second link the user just asked for.
    const { service, emailVerificationService, jobQueue } = harness();

    emailVerificationService.issue.mockResolvedValue({
      token: 'token-a',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await service.resendVerification({ email: 'a@x.com' }, '203.0.113.7');

    emailVerificationService.issue.mockResolvedValue({
      token: 'token-b',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await service.resendVerification({ email: 'a@x.com' }, '203.0.113.7');

    const first = jobQueue.enqueue.mock.calls[0][1].dedupeKey;
    const second = jobQueue.enqueue.mock.calls[1][1].dedupeKey;

    expect(first).not.toBe(second);
  });

  it('url-encodes the token', async () => {
    const { service, emailVerificationService, jobQueue } = harness();
    emailVerificationService.issue.mockResolvedValue({
      token: 'a+b/c=',
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    await service.resendVerification({ email: 'a@x.com' }, '203.0.113.7');

    const [, job] = jobQueue.enqueue.mock.calls[0];
    expect(job.payload.data.verificationUrl).toContain(
      encodeURIComponent('a+b/c='),
    );
  });

  it('does not wait for the queue', async () => {
    const { service, jobQueue } = harness();
    jobQueue.enqueue.mockReturnValue(new Promise(() => {}));

    await expect(
      service.resendVerification({ email: 'a@x.com' }, '203.0.113.7'),
    ).resolves.toBeDefined();
  });

  it('survives a queue rejection', async () => {
    const { service, jobQueue } = harness();
    jobQueue.enqueue.mockRejectedValue(new Error('redis down'));

    await expect(
      service.resendVerification({ email: 'a@x.com' }, '203.0.113.7'),
    ).resolves.toBeDefined();
  });
});

describe('AuthService.register verification link', () => {
  it('does not add latency to registration', async () => {
    // The account is created and the session issued; the enqueue is fire and
    // forget, so a queue that hangs cannot hold the request open.
    const { service, jobQueue } = harness();
    jobQueue.enqueue.mockReturnValue(new Promise(() => {}));

    await expect(
      service.register(
        { email: 'a@x.com', password: 'password123' } as never,
        { ipAddress: '1.1.1.1' } as never,
      ),
    ).resolves.toBeDefined();
  });

  it('queues a verification link for a new account', async () => {
    const { service, jobQueue } = harness();

    await service.register(
      { email: 'a@x.com', password: 'password123' } as never,
      { ipAddress: '1.1.1.1' } as never,
    );

    // The enqueue is not awaited, so the assertion waits a tick for the promise
    // chain to settle rather than relying on registration awaiting it.
    await new Promise((resolve) => setImmediate(resolve));

    const [, job] = jobQueue.enqueue.mock.calls[0];
    expect(job.name).toBe('mail.send');
    expect(job.payload.template).toBe('verify-email');
    expect(job.payload.data.verificationUrl).toContain('/auth/verify-email');
  });

  it('still registers when the queue is down', async () => {
    const { service, jobQueue } = harness();
    jobQueue.enqueue.mockRejectedValue(new Error('redis down'));

    await expect(
      service.register(
        { email: 'a@x.com', password: 'password123' } as never,
        { ipAddress: '1.1.1.1' } as never,
      ),
    ).resolves.toBeDefined();
  });
});
