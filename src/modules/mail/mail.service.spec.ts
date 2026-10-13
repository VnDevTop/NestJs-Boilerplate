import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../configs/app.config.js';
import type { MailConfig } from '../../configs/mail.config.js';
import { MetricsService } from '../../core/metrics/index.js';
import {
  MAIL_TRANSPORT,
  MailService,
  selectTransport,
} from './mail.service.js';
import { MemoryMailTransport } from './transports/memory.transport.js';
import type {
  MailMessage,
  MailTransport,
  SendResult,
} from './transports/transport.interface.js';

const mailConfig: MailConfig = {
  transport: 'memory',
  fromName: 'Example',
  from: 'no-reply@example.com',
  subjectPrefix: '',
  smtp: { host: 'localhost', port: 587, secure: false },
  sendgrid: {},
  ses: {},
  timeouts: { connection: 5000, socket: 10000 },
};

const appConfig: AppConfig = {
  env: 'test',
  name: 'Example',
  port: 3000,
  globalPrefix: 'api',
  version: '1',
  url: 'https://app.example.com',
};

/** Records what it was asked to send, and can be told to fail. */
class RecordingTransport implements MailTransport {
  readonly name = 'recording';
  readonly sent: {
    to: string;
    subject: string;
    mailId: string;
    template?: string;
  }[] = [];

  constructor(private readonly behaviour: 'ok' | 'fail' = 'ok') {}

  async send(message: MailMessage): Promise<SendResult> {
    if (this.behaviour === 'fail') {
      throw new Error('provider unreachable');
    }

    this.sent.push({
      to: Array.isArray(message.to) ? message.to.join(',') : message.to,
      subject: message.subject,
      mailId: message.mailId,
      template: message.template,
    });

    return { accepted: ['a'], rejected: [] };
  }
}

function build(
  transport: MailTransport,
  overrides: { mail?: Partial<MailConfig>; app?: Partial<AppConfig> } = {},
) {
  const configService = {
    getOrThrow: (key: string) => {
      if (key === 'mail') {
        return { ...mailConfig, ...overrides.mail };
      }

      if (key === 'app') {
        return { ...appConfig, ...overrides.app };
      }

      throw new Error(`unexpected namespace ${key}`);
    },
  } as unknown as ConfigService;

  // A real `MetricsService` rather than a fake: with `prom-client` absent it is a
  // no-op, and that is the state this suite most likely runs in. Asserting against
  // a fake would test the fake.
  return new MailService(transport, new MetricsService(), configService);
}

const welcomeData = { firstName: 'Ada', appName: 'Example' };

describe('MailService.sendTemplate', () => {
  let transport: RecordingTransport;

  beforeEach(() => {
    transport = new RecordingTransport();
  });

  it('renders and sends a template', async () => {
    await build(transport).sendTemplate(
      'user@example.com',
      'welcome',
      welcomeData,
    );

    expect(transport.sent[0]).toMatchObject({
      to: 'user@example.com',
      subject: 'Welcome to Example',
      template: 'welcome',
    });
  });

  it('returns a mail id that names the template', async () => {
    const result = await build(transport).sendTemplate(
      'user@example.com',
      'welcome',
      welcomeData,
    );

    expect(result.mailId).toMatch(/^welcome-[0-9a-f-]{36}$/);
  });

  it('gives two sends of the same template different ids', async () => {
    const service = build(transport);

    const first = await service.sendTemplate('a@x.com', 'welcome', welcomeData);
    const second = await service.sendTemplate(
      'b@x.com',
      'welcome',
      welcomeData,
    );

    expect(first.mailId).not.toBe(second.mailId);
  });

  it('reports which template was sent alongside the id', async () => {
    const result = await build(transport).sendTemplate(
      'a@x.com',
      'welcome',
      welcomeData,
    );

    expect(result.template).toBe('welcome');
  });

  it('sends both body parts', async () => {
    const send = vi.spyOn(transport, 'send');
    await build(transport).sendTemplate('a@x.com', 'welcome', welcomeData);

    const message = send.mock.calls[0][0];
    expect(message.text).toBeTruthy();
    expect(message.html).toBeTruthy();
  });

  it('applies the configured subject prefix', async () => {
    // The service adds the brackets, so the configured value is the bare prefix.
    await build(transport, { mail: { subjectPrefix: 'Example' } }).sendTemplate(
      'a@x.com',
      'welcome',
      welcomeData,
    );

    expect(transport.sent[0].subject).toBe('[Example] Welcome to Example');
  });

  it('leaves the subject alone with no prefix configured', async () => {
    await build(transport).sendTemplate('a@x.com', 'welcome', welcomeData);

    expect(transport.sent[0].subject).not.toMatch(/^\[/);
  });

  it('lets a call override the configured prefix', async () => {
    await build(transport, { mail: { subjectPrefix: 'Config' } }).sendTemplate(
      'a@x.com',
      'welcome',
      welcomeData,
      { subjectPrefix: 'Override' },
    );

    expect(transport.sent[0].subject).toBe('[Override] Welcome to Example');
  });

  it('reports a successful send as delivered', async () => {
    const result = await build(transport).sendTemplate(
      'a@x.com',
      'welcome',
      welcomeData,
    );

    expect(result.delivered).toBe(true);
  });

  it('carries the provider id through', async () => {
    vi.spyOn(transport, 'send').mockResolvedValue({
      accepted: ['a@x.com'],
      rejected: [],
      providerId: 'prov-1',
    });

    const result = await build(transport).sendTemplate(
      'a@x.com',
      'welcome',
      welcomeData,
    );

    expect(result.providerId).toBe('prov-1');
  });

  it('passes cc, bcc and attachments through', async () => {
    const send = vi.spyOn(transport, 'send');
    await build(transport).sendTemplate('a@x.com', 'welcome', welcomeData, {
      cc: ['cc@x.com'],
      bcc: ['bcc@x.com'],
      attachments: [{ filename: 'a.txt', content: 'hi' }],
    });

    const message = send.mock.calls[0][0];
    expect(message.cc).toEqual(['cc@x.com']);
    expect(message.bcc).toEqual(['bcc@x.com']);
    expect(message.attachments).toHaveLength(1);
  });
});

describe('MailService on a provider failure', () => {
  it('does not throw, because a mail outage must not fail a registration', async () => {
    const service = build(new RecordingTransport('fail'));

    await expect(
      service.sendTemplate('a@x.com', 'welcome', welcomeData),
    ).resolves.toMatchObject({ delivered: false });
  });

  it('reports nothing accepted, rather than claiming a delivery', async () => {
    const result = await build(new RecordingTransport('fail')).sendTemplate(
      'a@x.com',
      'welcome',
      welcomeData,
    );

    expect(result.accepted).toEqual([]);
  });

  it('still returns the mail id, so a failed send is traceable', async () => {
    const result = await build(new RecordingTransport('fail')).sendTemplate(
      'a@x.com',
      'welcome',
      welcomeData,
    );

    expect(result.mailId).toMatch(/^welcome-/);
  });

  it('handles a thrown non-error, which some clients do', async () => {
    // Rejecting with a string rather than an Error is a real shape from a
    // promisified callback client, and reading error.message off it would
    // itself throw inside the catch.
    const transport = new RecordingTransport();
    vi.spyOn(transport, 'send').mockRejectedValue('a string, not an error');

    const result = await build(transport).sendTemplate(
      'a@x.com',
      'welcome',
      welcomeData,
    );

    expect(result.delivered).toBe(false);
  });
});

describe('MailService.buildUrl', () => {
  it('joins the app url with a path', () => {
    expect(build(new RecordingTransport()).buildUrl('/auth/verify')).toBe(
      'https://app.example.com/auth/verify',
    );
  });

  it('adds the slash when the caller omits it', () => {
    expect(build(new RecordingTransport()).buildUrl('auth/verify')).toBe(
      'https://app.example.com/auth/verify',
    );
  });

  it('does not double the slash, which would break the link', () => {
    const service = build(new RecordingTransport(), {
      app: { url: 'https://app.example.com/' },
    });

    expect(service.buildUrl('/auth/verify')).toBe(
      'https://app.example.com/auth/verify',
    );
  });

  it('keeps a sub-path deployment working', () => {
    const service = build(new RecordingTransport(), {
      app: { url: 'https://example.com/api' },
    });

    expect(service.buildUrl('/auth/verify')).toBe(
      'https://example.com/api/auth/verify',
    );
  });
});

describe('MailService.transportName', () => {
  it('reports the active transport for the health check', () => {
    expect(build(new MemoryMailTransport()).transportName).toBe('memory');
  });
});

describe('selectTransport', () => {
  it('uses the memory transport when that is configured', () => {
    const { transport, fellBack } = selectTransport(mailConfig);

    expect(transport.name).toBe('memory');
    expect(fellBack).toBe(false);
  });

  it('falls back to memory when the provider package is missing', () => {
    // No provider package is installed in this repo, which is the point: the
    // app must boot and a feature nobody enabled must cost nothing.
    for (const name of ['smtp', 'ses', 'sendgrid'] as const) {
      const { transport, fellBack } = selectTransport({
        ...mailConfig,
        transport: name,
      });

      expect(transport.name).toBe('memory');
      expect(fellBack).toBe(true);
    }
  });

  it('returns a transport that can actually send, never one that throws', async () => {
    const { transport } = selectTransport({ ...mailConfig, transport: 'smtp' });

    // The fallback is not a decision about failing fast: the send must succeed
    // so a registration is not turned into a 500 by a missing package.
    await expect(
      transport.send({
        to: 'a@x.com',
        subject: 's',
        text: 't',
        mailId: 'm-1',
      }),
    ).resolves.toMatchObject({ accepted: ['a@x.com'] });
  });
});

describe('MailService as a Nest provider', () => {
  it('resolves the transport through the injection token', async () => {
    const memory = new MemoryMailTransport();

    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: MAIL_TRANSPORT, useValue: memory },
        // The real service, for the same reason the plain harness uses it: with
        // `prom-client` absent every method is a no-op, and that is the state this
        // runs in.
        MetricsService,
        MailService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: (key: string) =>
              key === 'mail' ? mailConfig : appConfig,
          },
        },
      ],
    }).compile();

    const service = moduleRef.get(MailService);
    await service.sendTemplate('a@x.com', 'welcome', welcomeData);

    expect(memory.getSent()).toHaveLength(1);
    expect(memory.getSent()[0].mailId).toMatch(/^welcome-/);
    await moduleRef.close();
  });
});
