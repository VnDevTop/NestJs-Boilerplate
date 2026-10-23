import { describe, expect, it, vi } from 'vitest';

import type { MailService, SendMailResult } from '../../mail/index.js';
import type { Job } from '../queue.interface.js';
import {
  MAIL_JOB,
  MailProcessor,
  type MailJobPayload,
} from './mail.processor.js';
import { DEFAULT_TENANT_ID } from '../../../common/tenancy/tenant.constants.js';

const WELCOME = { firstName: 'Ada', appName: 'Example' };

function payload(overrides: Partial<MailJobPayload> = {}): MailJobPayload {
  return { to: 'a@x.com', template: 'welcome', data: WELCOME, ...overrides };
}

function job(
  overrides: Partial<Job<MailJobPayload>> = {},
): Job<MailJobPayload> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: DEFAULT_TENANT_ID,
    name: MAIL_JOB,
    payload: payload(),
    ...overrides,
  };
}

/** A MailService whose result the test decides. */
function mailService(result: Partial<SendMailResult> = {}) {
  const sendTemplate = vi.fn().mockResolvedValue({
    accepted: ['a@x.com'],
    rejected: [],
    mailId: 'welcome-1',
    template: 'welcome',
    delivered: true,
    ...result,
  } as SendMailResult);

  return {
    mailService: { sendTemplate } as unknown as MailService,
    sendTemplate,
  };
}

describe('MailProcessor.handles', () => {
  it('claims the mail job', () => {
    expect(MailProcessor.handles(MAIL_JOB)).toBe(true);
  });

  it('does not claim another job, so routing cannot misfire', () => {
    expect(MailProcessor.handles('notification.send')).toBe(false);
    expect(MailProcessor.handles('retention.run')).toBe(false);
    expect(MailProcessor.handles('')).toBe(false);
  });
});

describe('MailProcessor on success', () => {
  it('passes the recipient, template and data through untouched', async () => {
    const { mailService: service, sendTemplate } = mailService();

    await new MailProcessor(service).process(job());

    expect(sendTemplate).toHaveBeenCalledWith(
      'a@x.com',
      'welcome',
      WELCOME,
      expect.anything(),
    );
  });

  it('forwards the optional subject prefix and reply-to', async () => {
    const { mailService: service, sendTemplate } = mailService();

    await new MailProcessor(service).process(
      job({ payload: payload({ subjectPrefix: 'X', replyTo: 'r@x.com' }) }),
    );

    expect(sendTemplate).toHaveBeenCalledWith('a@x.com', 'welcome', WELCOME, {
      subjectPrefix: 'X',
      replyTo: 'r@x.com',
    });
  });

  it('reports ok', async () => {
    const { mailService: service } = mailService();

    await expect(new MailProcessor(service).process(job())).resolves.toEqual({
      ok: true,
    });
  });
});

describe('MailProcessor retry classification', () => {
  it('retries a transient failure, which is what most failures are', async () => {
    const { mailService: s } = mailService({
      delivered: false,
      error: 'ETIMEDOUT',
    });

    const result = await new MailProcessor(s).process(job());

    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it('does not retry a 4xx, which would be refused the same way every time', async () => {
    const { mailService: s } = mailService({
      delivered: false,
      permanent: true,
      status: 401,
      error: 'invalid api key',
    });

    const result = await new MailProcessor(s).process(job());

    expect(result.retryable).toBe(false);
  });

  it('retries a 5xx, because the provider may recover', async () => {
    const { mailService: s } = mailService({
      delivered: false,
      status: 503,
      error: 'service unavailable',
    });

    expect((await new MailProcessor(s).process(job())).retryable).toBe(true);
  });

  it('carries the reason, so the dead-letter entry is not empty', async () => {
    const { mailService: s } = mailService({
      delivered: false,
      error: 'invalid api key',
      permanent: true,
    });

    expect((await new MailProcessor(s).process(job())).error).toBe(
      'invalid api key',
    );
  });

  it('says something when the transport gave no reason at all', async () => {
    const { mailService: s } = mailService({ delivered: false });

    // A dead-letter entry with no error is an entry nobody can act on.
    const result = await new MailProcessor(s).process(job());

    expect(result.error).toBe('delivery failed');
  });

  it('turns a thrown error into a retryable result, never a rejected promise', async () => {
    const throwing = {
      sendTemplate: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as MailService;

    // MailService swallows provider failures, so a throw here came from somewhere
    // else. It has to come back as a result: a rejected promise in the in-process
    // dispatcher would be an unhandled rejection, which takes the process down.
    const result = await new MailProcessor(throwing).process(job());

    expect(result).toEqual({ ok: false, error: 'boom', retryable: true });
  });

  it('handles a thrown non-error, which a promisified client can produce', async () => {
    const throwing = {
      sendTemplate: vi.fn().mockRejectedValue('just a string'),
    } as unknown as MailService;

    const result = await new MailProcessor(throwing).process(job());

    expect(result.error).toBe('just a string');
  });
});

describe('MailProcessor payload validation', () => {
  it('rejects a payload with no recipient', async () => {
    const { mailService: s, sendTemplate } = mailService();

    const result = await new MailProcessor(s).process(
      job({ payload: { ...payload(), to: '' } }),
    );

    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('rejects a payload with no template', async () => {
    const { mailService: s } = mailService();

    const result = await new MailProcessor(s).process(
      job({ payload: { ...payload(), template: undefined as never } }),
    );

    expect(result.retryable).toBe(false);
  });

  it('rejects a payload with no data', async () => {
    const { mailService: s } = mailService();

    const result = await new MailProcessor(s).process(
      job({ payload: { ...payload(), data: null as never } }),
    );

    expect(result.retryable).toBe(false);
  });

  it('rejects a payload that is not an object', async () => {
    const { mailService: s } = mailService();

    const result = await new MailProcessor(s).process(
      job({ payload: 'a string' as never }),
    );

    expect(result).toMatchObject({ ok: false, retryable: false });
  });

  it('marks a malformed payload permanent, since retrying it cannot help', async () => {
    const { mailService: s } = mailService();

    // A retryable malformed payload would burn the whole budget on a payload that
    // cannot become valid.
    const result = await new MailProcessor(s).process(
      job({ payload: { to: 'a@x.com' } as never }),
    );

    expect(result.retryable).toBe(false);
  });

  it('trims the recipient, so a padded address is not a send failure', async () => {
    const { mailService: s, sendTemplate } = mailService();

    await new MailProcessor(s).process(
      job({ payload: payload({ to: '  a@x.com  ' }) }),
    );

    expect(sendTemplate).toHaveBeenCalledWith(
      'a@x.com',
      'welcome',
      WELCOME,
      expect.anything(),
    );
  });
});
