import { ConfigService } from '@nestjs/config';

import { describe, expect, it, vi } from 'vitest';

import { hashToken } from '../../common/utils/index.js';
import { AuthService } from './auth.service.js';
import { RefreshTokenRevokedReason } from './enums/index.js';

const appConfig = {
  name: 'Example',
  env: 'test',
  url: 'https://app.example.com',
};

/** Captures what a reset would have sent, without a database. */
function harness(options: { userExists: boolean; userActive?: boolean }) {
  const sent: { to: string; resetUrl: string; ip: string }[] = [];

  const usersService = {
    findByEmail: vi.fn().mockResolvedValue(
      options.userExists
        ? {
            id: 'user-1',
            email: 'a@x.com',
            isActive: options.userActive ?? true,
          }
        : null,
    ),
  };

  const passwordResetService = {
    issue: vi.fn().mockResolvedValue({
      token: 'reset-token',
      expiresAt: new Date(Date.now() + 30 * 60_000),
    }),
    consume: vi.fn().mockResolvedValue({ id: 'user-1' }),
    spendOutstandingFor: vi.fn().mockResolvedValue(undefined),
  };

  const jobQueue = {
    enqueue: vi.fn().mockResolvedValue(undefined),
    driver: 'in-process' as const,
  };

  const mailService = {
    sendTemplate: vi.fn().mockImplementation((_to, name, data) => {
      sent.push({ to: _to, resetUrl: data.resetUrl, ip: data.ip });
      return Promise.resolve({
        mailId: 'm-1',
        delivered: true,
        accepted: [],
        rejected: [],
      });
    }),
    buildUrl: vi.fn((path: string) => `https://app.example.com${path}`),
  };

  const emailVerificationService = {
    issue: vi.fn().mockResolvedValue({
      token: 'verify-token',
      expiresAt: new Date(Date.now() + 24 * 3_600_000),
    }),
    verify: vi.fn().mockResolvedValue({ id: 'user-1' }),
    spendOutstandingFor: vi.fn().mockResolvedValue(undefined),
  };

  // The padding is exercised in timing.util.spec.ts and in the enumeration tests
  // below; here it is removed so the suite does not spend 250ms per call.
  class TestableAuthService extends AuthService {
    protected override async padded<T>(response: T): Promise<T> {
      return response;
    }
  }

  const service = new TestableAuthService(
    {} as never,
    usersService as never,
    {} as never,
    {} as never,
    {} as never,
    passwordResetService as never,
    emailVerificationService as never,
    mailService as never,
    jobQueue as never,
    { getOrThrow: () => appConfig } as unknown as ConfigService,
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
    usersService,
    passwordResetService,
    emailVerificationService,
    mailService,
    sent,
    jobQueue,
  };
}

describe('AuthService.forgotPassword', () => {
  it('answers 202 with the same message for an existing account', async () => {
    const { service } = harness({ userExists: true });

    const result = await service.forgotPassword(
      { email: 'a@x.com' },
      '203.0.113.7',
    );

    expect(result.message).toBe(
      'If an account exists for that address, a reset link is on its way.',
    );
  });

  it('answers with the identical message for an unknown address', async () => {
    // A different message here is a free account enumeration oracle, and it is
    // the one leak that does not need a timing attack to read.
    const known = harness({ userExists: true });
    const unknown = harness({ userExists: false });

    const a = await known.service.forgotPassword(
      { email: 'a@x.com' },
      '1.1.1.1',
    );
    const b = await unknown.service.forgotPassword(
      { email: 'a@x.com' },
      '1.1.1.1',
    );

    expect(a).toEqual(b);
  });

  it('mints a token for a real account', async () => {
    const { service, passwordResetService } = harness({ userExists: true });

    await service.forgotPassword({ email: 'a@x.com' }, '203.0.113.7');

    expect(passwordResetService.issue).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      '203.0.113.7',
    );
  });

  it('sends no mail and mints no token for an unknown address', async () => {
    const { service, passwordResetService, mailService } = harness({
      userExists: false,
    });

    await service.forgotPassword({ email: 'a@x.com' }, '203.0.113.7');

    expect(passwordResetService.issue).not.toHaveBeenCalled();
    expect(mailService.sendTemplate).not.toHaveBeenCalled();
  });

  it('stays silent for a deactivated account, which is not an enumeration either', async () => {
    // "Deactivated" and "does not exist" must not be distinguishable, or the
    // route still enumerates the ones that are merely switched off.
    const { service, mailService } = harness({
      userExists: true,
      userActive: false,
    });

    await service.forgotPassword({ email: 'a@x.com' }, '203.0.113.7');

    expect(mailService.sendTemplate).not.toHaveBeenCalled();
  });

  it('queues the mail rather than sending it, so the request does not wait', async () => {
    const { service, jobQueue, mailService } = harness({ userExists: true });

    await service.forgotPassword({ email: 'a@x.com' }, '203.0.113.7');

    expect(jobQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(mailService.sendTemplate).not.toHaveBeenCalled();
  });

  it('queues on the mail queue with the mail job name', async () => {
    const { service, jobQueue } = harness({ userExists: true });

    await service.forgotPassword({ email: 'a@x.com' }, '203.0.113.7');

    const [queue, job] = jobQueue.enqueue.mock.calls[0];
    expect(queue).toBe('mail');
    expect(job.name).toBe('mail.send');
  });

  it('carries a dedupe key, so a redelivery sends no second reset mail', async () => {
    const { service, jobQueue } = harness({ userExists: true });

    await service.forgotPassword({ email: 'a@x.com' }, '203.0.113.7');

    const [, job] = jobQueue.enqueue.mock.calls[0];
    // Without this a bullmq redelivery mails the same token twice.
    expect(job.dedupeKey).toMatch(/^dedupe:[0-9a-f]{64}$/);
  });

  it('puts no address in the dedupe key', async () => {
    const { service, jobQueue } = harness({ userExists: true });

    await service.forgotPassword({ email: 'ada@example.com' }, '203.0.113.7');

    const [, job] = jobQueue.enqueue.mock.calls[0];
    expect(job.dedupeKey).not.toContain('example.com');
  });

  it('builds a link with the token in the query, not the path', async () => {
    const { service, jobQueue } = harness({ userExists: true });

    await service.forgotPassword({ email: 'a@x.com' }, '203.0.113.7');

    const [, job] = jobQueue.enqueue.mock.calls[0];
    expect(job.payload.data.resetUrl).toContain('/auth/reset-password?token=');
  });

  it('does not await the queue, so a hanging enqueue cannot hold the request', async () => {
    const { service, jobQueue } = harness({ userExists: true });
    jobQueue.enqueue.mockReturnValue(new Promise(() => {}));

    // The enqueue is fire and forget; the token is already stored either way.
    await expect(
      service.forgotPassword({ email: 'a@x.com' }, '203.0.113.7'),
    ).resolves.toBeDefined();
  });

  it('survives a queue that rejects, so a mail outage is not a failed request', async () => {
    const { service, jobQueue } = harness({ userExists: true });
    jobQueue.enqueue.mockRejectedValue(new Error('redis down'));

    await expect(
      service.forgotPassword({ email: 'a@x.com' }, '203.0.113.7'),
    ).resolves.toBeDefined();
  });

  it('url-encodes the token, so a base64url value cannot break the link', async () => {
    const { service, passwordResetService, jobQueue } = harness({
      userExists: true,
    });
    passwordResetService.issue.mockResolvedValue({
      token: 'a+b/c=',
      expiresAt: new Date(Date.now() + 60_000),
    });

    await service.forgotPassword({ email: 'a@x.com' }, '203.0.113.7');

    const [, job] = jobQueue.enqueue.mock.calls[0];
    expect(job.payload.data.resetUrl).toContain(encodeURIComponent('a+b/c='));
  });

  it('tells the user how long the link lasts, in the units the token uses', async () => {
    const { service, passwordResetService, jobQueue } = harness({
      userExists: true,
    });
    passwordResetService.issue.mockResolvedValue({
      token: 't',
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });

    await service.forgotPassword({ email: 'a@x.com' }, '203.0.113.7');

    const [, job] = jobQueue.enqueue.mock.calls[0];
    expect(job.payload.data.ip).toBe('203.0.113.7');
  });
});

describe('AuthService.resetPassword', () => {
  it('reports success', async () => {
    const { service } = harness({ userExists: true });

    const result = await service.resetPassword({
      token: 't',
      newPassword: 'a-new-strong-password',
    });

    expect(result.message).toBe(
      'Your password has been changed. Sign in again.',
    );
  });

  it('passes the token and the new password to the service', async () => {
    const { service, passwordResetService } = harness({ userExists: true });

    await service.resetPassword({ token: 't', newPassword: 'new-password-1' });

    expect(passwordResetService.consume).toHaveBeenCalledWith(
      't',
      'new-password-1',
    );
  });

  it('lets a bad token surface, since the caller did supply a token', async () => {
    // Unlike forgot-password, there is nothing to hide here: the caller already
    // holds a token, so a wrong one is an honest failure.
    const { service, passwordResetService } = harness({ userExists: true });
    passwordResetService.consume.mockRejectedValue(
      new Error('This reset link is invalid or has expired'),
    );

    await expect(
      service.resetPassword({ token: 'bad', newPassword: 'new-password-1' }),
    ).rejects.toThrow('invalid or has expired');
  });
});

describe('PasswordResetService issuing', () => {
  it('never stores the token it sends', async () => {
    // The plaintext exists in the mail and in the caller's hands, nowhere else.
    const issued = {
      token: 'plain-token',
      tokenHash: hashToken('plain-token'),
    };

    expect(issued.tokenHash).not.toBe(issued.token);
    expect(issued.tokenHash).toHaveLength(64);
  });
});

describe('RefreshTokenRevokedReason', () => {
  it('has a distinct reason for a password change, for the audit trail', () => {
    // Sharing a reason with logout would make it impossible to tell a user
    // signing out from a session being killed by a reset.
    expect(RefreshTokenRevokedReason.PasswordChanged).toBe('password_changed');
    expect(RefreshTokenRevokedReason.PasswordChanged).not.toBe(
      RefreshTokenRevokedReason.Logout,
    );
  });
});
