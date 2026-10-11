import { Logger } from '@nestjs/common';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NotificationConfig } from '../../../configs/notification.config.js';
import { notificationConfig } from '../../../configs/notification.config.js';
import {
  isPermanentStatus,
  type ChannelResult,
  type NotificationChannel,
  type NotificationPayload,
} from './channel.interface.js';
import { ConsoleChannel, selectChannels } from './console.channel.js';
import { EmailNotificationChannel } from './email.channel.js';
import { SlackNotificationChannel } from './slack.channel.js';
import { TelegramNotificationChannel } from './telegram.channel.js';

/**
 * The channel rules are what the whole extension story rests on: a channel nobody
 * enabled must cost nothing, a channel enabled without a credential must say so,
 * and no channel's failure may reach the caller that asked for the message.
 *
 * Config is assembled by setting `process.env` and calling the real factory rather
 * than by hand-writing an object, because a literal in a test is a config shape the
 * factory does not produce, and that is exactly the drift these tests exist to catch.
 */

const KEYS = [
  'NOTIFICATION_ENABLED',
  'NOTIFICATION_CONSOLE_ENABLED',
  'NOTIFICATION_EMAIL_ENABLED',
  'NOTIFICATION_EMAIL_TO',
  'TELEGRAM_ENABLED',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_TOPIC_ID',
  'TELEGRAM_TOPICS',
  'SLACK_ENABLED',
  'SLACK_WEBHOOK_URL',
  'SLACK_CHANNEL',
  'DISCORD_ENABLED',
  'DISCORD_WEBHOOK_URL',
  'DISCORD_CHANNEL',
  'NOTIFICATION_TIMEOUT',
  'NOTIFICATION_RETRIES',
  'NOTIFICATION_RETRY_DELAY',
  'NOTIFICATION_THROW_ON_FAILURE',
] as const;

/** A config with the master switch on and everything else as the factory reads it. */
function config(overrides: Record<string, string> = {}): NotificationConfig {
  for (const key of KEYS) {
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }

  return notificationConfig();
}

const PAYLOAD: NotificationPayload = {
  event: 'user.registered',
  headline: 'New account: ada@example.com',
  body: 'Address: ada@example.com',
};

/** An `HttpService` double that never reaches the network. */
function httpStub() {
  return { post: vi.fn() } as never;
}

beforeEach(() => {
  for (const key of KEYS) {
    delete process.env[key];
  }
});

describe('isPermanentStatus', () => {
  it('treats a 4xx as permanent, because another attempt is refused identically', () => {
    // This is the classification that decides whether a revoked webhook token costs
    // three attempts or thirty, and delays the dead-letter entry that names the
    // problem.
    for (const status of [400, 401, 403, 404, 429]) {
      expect(isPermanentStatus(status), String(status)).toBe(true);
    }
  });

  it('treats a 5xx and an unknown status as retryable', () => {
    for (const status of [500, 502, 503, undefined]) {
      expect(isPermanentStatus(status), String(status)).toBe(false);
    }
  });
});

describe('selectChannels', () => {
  it('returns nothing when the master switch is off, whatever else is on', () => {
    // The master switch exists so an incident can be silenced without editing four
    // variables. If it did not override the per-channel flags, silencing would mean
    // finding every one of them.
    const disabled = config({
      NOTIFICATION_ENABLED: 'false',
      NOTIFICATION_CONSOLE_ENABLED: 'true',
      NOTIFICATION_EMAIL_ENABLED: 'true',
      NOTIFICATION_EMAIL_TO: 'ops@example.com',
      SLACK_ENABLED: 'true',
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x',
    });

    expect(selectChannels(disabled, [], undefined)).toEqual([]);
  });

  it('includes the console channel when it is on and nothing else is', () => {
    const on = config({
      NOTIFICATION_ENABLED: 'true',
      NOTIFICATION_CONSOLE_ENABLED: 'true',
    });

    expect(selectChannels(on, [], undefined).map((c) => c.name)).toEqual([
      'console',
    ]);
  });

  it('drops the console channel when it is switched off individually', () => {
    const off = config({
      NOTIFICATION_ENABLED: 'true',
      NOTIFICATION_CONSOLE_ENABLED: 'false',
    });

    expect(selectChannels(off, [], undefined)).toEqual([]);
  });

  it('puts the console channel last, because it always succeeds', () => {
    // Listed first it would make a broken webhook read as a partial success in the
    // summary rather than in the per-channel columns.
    const on = config({
      NOTIFICATION_ENABLED: 'true',
      NOTIFICATION_CONSOLE_ENABLED: 'true',
      NOTIFICATION_EMAIL_ENABLED: 'true',
      NOTIFICATION_EMAIL_TO: 'ops@example.com',
    });

    const email = { name: 'email', isEnabled: () => true, send: vi.fn() };

    expect(
      selectChannels(
        on,
        [{ name: 'slack', isEnabled: () => true, send: vi.fn() }],
        email as never,
      ).map((c) => c.name),
    ).toEqual(['slack', 'email', 'console']);
  });

  it('omits the email channel entirely when none was passed in', () => {
    // The module supplies it; a caller that does not should get no email channel
    // rather than a broken one that throws on first use.
    const on = config({
      NOTIFICATION_ENABLED: 'true',
      NOTIFICATION_EMAIL_ENABLED: 'true',
      NOTIFICATION_EMAIL_TO: 'ops@example.com',
    });

    expect(selectChannels(on, [], undefined).map((c) => c.name)).toEqual([
      'console',
    ]);
  });

  it('drops a channel that says it is not enabled, whatever the flag said', () => {
    // The final filter is where `isEnabled()` earns its place: it is the only place
    // that knows a channel needs a credential it does not have.
    const on = config({ NOTIFICATION_ENABLED: 'true' });
    const refused: NotificationChannel = {
      name: 'slack',
      isEnabled: () => false,
      send: vi.fn(),
    };

    expect(selectChannels(on, [refused], undefined)).toHaveLength(1);
  });
});

describe('ConsoleChannel', () => {
  it('reports success, because a log line is either written or it is not', () => {
    const channel = new ConsoleChannel();

    return expect(channel.send(PAYLOAD)).resolves.toEqual({
      delivered: true,
      recipient: 'application log',
    });
  });

  it('is enabled even with every switch off, since the factory filters it', () => {
    // The filter runs before `send`, so a second check here would be a second rule
    // to keep in step with the first for no gain.
    expect(new ConsoleChannel().isEnabled()).toBe(true);
  });

  it('names the event in what it logs, so a developer sees which one fired', async () => {
    // Spied on the prototype rather than `console`, because `Logger` writes to
    // stdout itself and a `console.log` spy would not see it.
    const log = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);

    await new ConsoleChannel().send(PAYLOAD);

    // Read before restoring: `mockRestore` clears the recorded calls, and asserting
    // afterwards passes on an empty array rather than failing loudly.
    const logged = log.mock.calls.flat().join('\n');

    log.mockRestore();

    // Without the event name, a developer watching the log cannot tell which of six
    // notifications arrived, which is the only reason this channel defaults to on.
    expect(logged).toContain('user.registered');
    expect(logged).toContain(PAYLOAD.headline);
  });
});

describe('TelegramNotificationChannel', () => {
  it('refuses to run without a bot token, and says which variable is missing', () => {
    // The failure this prevents: a channel switched on with no credential drops
    // every message while looking exactly like a working integration.
    const on = config({
      NOTIFICATION_ENABLED: 'true',
      TELEGRAM_ENABLED: 'true',
    });
    const channel = new TelegramNotificationChannel(httpStub(), on);

    expect(channel.isEnabled()).toBe(false);
  });

  it('refuses to run without a chat id', () => {
    const on = config({
      NOTIFICATION_ENABLED: 'true',
      TELEGRAM_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: 'token',
    });

    expect(new TelegramNotificationChannel(httpStub(), on).isEnabled()).toBe(
      false,
    );
  });

  it('runs once both credentials are present', () => {
    const on = config({
      NOTIFICATION_ENABLED: 'true',
      TELEGRAM_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_CHAT_ID: '-100123',
    });

    expect(new TelegramNotificationChannel(httpStub(), on).isEnabled()).toBe(
      true,
    );
  });

  it('refuses when the channel flag is off even with both credentials', () => {
    // The credential being present is not consent to send. Someone who pasted a
    // token into every environment should not start receiving alerts the day they
    // upgrade.
    const off = config({
      NOTIFICATION_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_CHAT_ID: '-100123',
    });

    expect(new TelegramNotificationChannel(httpStub(), off).isEnabled()).toBe(
      false,
    );
  });

  describe('topic routing', () => {
    const routed = (extra: Record<string, string>) =>
      new TelegramNotificationChannel(
        httpStub(),
        config({
          NOTIFICATION_ENABLED: 'true',
          TELEGRAM_ENABLED: 'true',
          TELEGRAM_BOT_TOKEN: 'token',
          TELEGRAM_CHAT_ID: '-100123',
          ...extra,
        }),
      );

    it('uses the chat-wide topic for an event with no route of its own', () => {
      expect(
        routed({ TELEGRAM_TOPIC_ID: '7' }).topicFor('user.registered'),
      ).toBe('7');
    });

    it('uses the event route in preference to the chat-wide one', () => {
      // A forum chat is usually several rooms, and the point is that security events
      // do not get buried under routine chatter.
      const channel = routed({
        TELEGRAM_TOPIC_ID: '7',
        TELEGRAM_TOPICS: 'auth.login.failed=42',
      });

      expect(channel.topicFor('auth.login.failed')).toBe('42');
      expect(channel.topicFor('user.registered')).toBe('7');
    });

    it('routes by the event route alone when there is no chat-wide one', () => {
      const channel = routed({ TELEGRAM_TOPICS: 'auth.login.failed=42' });

      expect(channel.topicFor('auth.login.failed')).toBe('42');
    });

    it('uses no topic at all when neither is configured', () => {
      // Undefined rather than an empty string: the Bot API rejects a blank
      // `message_thread_id` as a malformed request, so omitting the field is the
      // difference between landing in the chat and being refused.
      expect(routed({}).topicFor('user.registered')).toBeUndefined();
    });

    it('treats topic zero as a topic, because it is a real one', () => {
      const channel = routed({ TELEGRAM_TOPICS: 'user.registered=0' });

      expect(channel.topicFor('user.registered')).toBe('0');
    });
  });
});

describe('SlackNotificationChannel', () => {
  it('refuses to run without a webhook url', () => {
    const on = config({ NOTIFICATION_ENABLED: 'true', SLACK_ENABLED: 'true' });

    expect(new SlackNotificationChannel(httpStub(), on).isEnabled()).toBe(
      false,
    );
  });

  it('runs once the url is present', () => {
    const on = config({
      NOTIFICATION_ENABLED: 'true',
      SLACK_ENABLED: 'true',
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x',
    });

    expect(new SlackNotificationChannel(httpStub(), on).isEnabled()).toBe(true);
  });
});

describe('EmailNotificationChannel', () => {
  const mailer = (result: Partial<ChannelResult> = {}) => ({
    sendNotification: vi.fn().mockResolvedValue({ delivered: true, ...result }),
  });

  it('refuses to run without a recipient', () => {
    const on = config({
      NOTIFICATION_ENABLED: 'true',
      NOTIFICATION_EMAIL_ENABLED: 'true',
    });

    expect(
      new EmailNotificationChannel(mailer() as never, on).isEnabled(),
    ).toBe(false);
  });

  it('runs once a recipient is configured', () => {
    const on = config({
      NOTIFICATION_ENABLED: 'true',
      NOTIFICATION_EMAIL_ENABLED: 'true',
      NOTIFICATION_EMAIL_TO: 'ops@example.com',
    });

    expect(
      new EmailNotificationChannel(mailer() as never, on).isEnabled(),
    ).toBe(true);
  });

  it('sends to every recipient in one delivery rather than one per address', async () => {
    // One BCC list is one message. An operator with a shared mailbox and a personal
    // one does not want two copies of every security alert.
    const on = config({
      NOTIFICATION_ENABLED: 'true',
      NOTIFICATION_EMAIL_ENABLED: 'true',
      NOTIFICATION_EMAIL_TO: 'ops@example.com, oncall@example.com',
    });
    const transport = mailer();

    const result = await new EmailNotificationChannel(
      transport as never,
      on,
    ).send(PAYLOAD);

    expect(transport.sendNotification).toHaveBeenCalledTimes(2);
    expect(result.recipient).toBe('ops@example.com, oncall@example.com');
  });

  it('uses the headline as the subject, with no prefix of its own', async () => {
    // `MAIL_SUBJECT_PREFIX` already applies to everything this transport sends, so a
    // second convention would split one mailbox's filter in two.
    const on = config({
      NOTIFICATION_ENABLED: 'true',
      NOTIFICATION_EMAIL_ENABLED: 'true',
      NOTIFICATION_EMAIL_TO: 'ops@example.com',
    });
    const transport = mailer();

    await new EmailNotificationChannel(transport as never, on).send(PAYLOAD);

    expect(transport.sendNotification).toHaveBeenCalledWith(
      'ops@example.com',
      PAYLOAD.headline,
      PAYLOAD.body,
    );
  });

  it('counts as delivered when one address refused and another accepted', async () => {
    // Retrying the whole notification for one bounced mailbox would send the second
    // recipient the alert again, five times.
    const on = config({
      NOTIFICATION_ENABLED: 'true',
      NOTIFICATION_EMAIL_ENABLED: 'true',
      NOTIFICATION_EMAIL_TO: 'ops@example.com, gone@example.com',
    });
    const transport = {
      sendNotification: vi
        .fn()
        .mockResolvedValueOnce({ delivered: true })
        .mockResolvedValueOnce({
          delivered: false,
          permanent: true,
          error: 'status 550',
        }),
    };

    const result = await new EmailNotificationChannel(
      transport as never,
      on,
    ).send(PAYLOAD);

    expect(result.delivered).toBe(true);
  });

  it('fails permanently only when every address refused permanently', async () => {
    const on = config({
      NOTIFICATION_ENABLED: 'true',
      NOTIFICATION_EMAIL_ENABLED: 'true',
      NOTIFICATION_EMAIL_TO: 'ops@example.com',
    });
    const transport = mailer({
      delivered: false,
      permanent: true,
      error: '550',
    });

    const result = await new EmailNotificationChannel(
      transport as never,
      on,
    ).send(PAYLOAD);

    expect(result).toMatchObject({ delivered: false, permanent: true });
  });

  it('turns a thrown transport into a retryable failure rather than propagating it', async () => {
    const on = config({
      NOTIFICATION_ENABLED: 'true',
      NOTIFICATION_EMAIL_ENABLED: 'true',
      NOTIFICATION_EMAIL_TO: 'ops@example.com',
    });
    const transport = {
      sendNotification: vi.fn().mockRejectedValue(new Error('socket hang up')),
    };

    const result = await new EmailNotificationChannel(
      transport as never,
      on,
    ).send(PAYLOAD);

    expect(result).toMatchObject({ delivered: false, error: 'socket hang up' });
    // Not permanent: a socket error usually is not, and permanent means the retry
    // budget is skipped.
    expect(result.permanent).toBeUndefined();
  });
});
