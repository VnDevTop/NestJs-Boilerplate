import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { notificationConfig, parseTopicRoutes } from './notification.config.js';

const KEYS = [
  'NOTIFICATION_ENABLED',
  'NOTIFICATION_CONSOLE_ENABLED',
  'TELEGRAM_ENABLED',
  'SLACK_ENABLED',
  'DISCORD_ENABLED',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_TOPIC_ID',
  'TELEGRAM_TOPICS',
  'NOTIFICATION_EMAIL_ENABLED',
  'NOTIFICATION_EMAIL_TO',
  'SLACK_WEBHOOK_URL',
  'SLACK_CHANNEL',
  'DISCORD_WEBHOOK_URL',
  'DISCORD_CHANNEL',
  'NOTIFICATION_TIMEOUT',
  'NOTIFICATION_RETRIES',
  'NOTIFICATION_RETRY_DELAY',
  'NOTIFICATION_THROW_ON_FAILURE',
] as const;

beforeEach(() => {
  for (const key of KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    delete process.env[key];
  }
});

describe('notificationConfig', () => {
  it('is off by default, so a fresh clone sends nothing', () => {
    expect(notificationConfig().enabled).toBe(false);
  });

  it('leaves the webhook channels off unless they are turned on', () => {
    expect(notificationConfig().channels).toMatchObject({
      telegram: false,
      slack: false,
      discord: false,
    });
  });

  it('enables the console channel by default, so local work is visible', () => {
    expect(notificationConfig().channels.console).toBe(true);
  });

  it('treats an explicit false as off, which is why the default is opt-in', () => {
    process.env.NOTIFICATION_ENABLED = 'false';
    process.env.TELEGRAM_ENABLED = 'false';

    const config = notificationConfig();

    expect(config.enabled).toBe(false);
    expect(config.channels.telegram).toBe(false);
  });

  it('turns each channel on independently', () => {
    process.env.TELEGRAM_ENABLED = 'true';
    process.env.SLACK_ENABLED = 'true';

    expect(notificationConfig().channels).toMatchObject({
      telegram: true,
      slack: true,
      discord: false,
    });
  });

  it('reads the telegram credentials and topic', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'token';
    process.env.TELEGRAM_CHAT_ID = '-100123';
    process.env.TELEGRAM_TOPIC_ID = '42';

    expect(notificationConfig().telegram).toEqual({
      botToken: 'token',
      chatId: '-100123',
      topicId: '42',
      topics: {},
    });
  });

  it('treats an absent topic as a single chat rather than an error', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'token';

    expect(notificationConfig().telegram.topicId).toBeUndefined();
  });

  it('keeps the webhook urls unset until a channel needs them', () => {
    expect(notificationConfig().slack.webhookUrl).toBeUndefined();
    expect(notificationConfig().discord.webhookUrl).toBeUndefined();
  });

  it('defaults a failure to a log, never a failed request', () => {
    expect(notificationConfig().delivery.throwOnFailure).toBe(false);
  });

  it('reads the delivery numbers', () => {
    process.env.NOTIFICATION_TIMEOUT = '9000';
    process.env.NOTIFICATION_RETRIES = '4';
    process.env.NOTIFICATION_RETRY_DELAY = '250';

    expect(notificationConfig().delivery).toEqual({
      timeout: 9000,
      retries: 4,
      retryDelay: 250,
      throwOnFailure: false,
    });
  });
});

describe('parseTopicRoutes', () => {
  it('reads event=topicId pairs', () => {
    expect(parseTopicRoutes('auth.login.failed=42,user.registered=7')).toEqual({
      'auth.login.failed': '42',
      'user.registered': '7',
    });
  });

  it('drops a pair with no topic rather than sending to topic empty', () => {
    // A topic id of "" is what the Bot API sees when the field is present and
    // blank, and it is rejected as a malformed request. Omitting the field is the
    // difference between landing in the default room and being refused outright.
    expect(parseTopicRoutes('auth.login.failed=')).toEqual({});
  });

  it('drops a pair with no event, which would route everything at once', () => {
    expect(parseTopicRoutes('=42')).toEqual({});
  });

  it('drops a pair with no separator at all', () => {
    expect(parseTopicRoutes('auth.login.failed')).toEqual({});
  });

  it('keeps going past a malformed pair rather than losing the good ones', () => {
    expect(parseTopicRoutes('garbage,auth.login.failed=42')).toEqual({
      'auth.login.failed': '42',
    });
  });

  it('trims, because a hand-edited value carries spaces', () => {
    expect(parseTopicRoutes(' auth.login.failed = 42 ')).toEqual({
      'auth.login.failed': '42',
    });
  });

  it('keeps a topic id of zero, which is a real forum topic', () => {
    expect(parseTopicRoutes('auth.login.failed=0')).toEqual({
      'auth.login.failed': '0',
    });
  });

  it('reads an absent value as no routes', () => {
    expect(parseTopicRoutes(undefined)).toEqual({});
    expect(parseTopicRoutes('')).toEqual({});
    expect(parseTopicRoutes('   ')).toEqual({});
  });
});

describe('the email channel', () => {
  it('is off by default even though the console channel is on', () => {
    // Mail costs money and can be rate-limited, and a developer with a real SMTP
    // credential in their environment should not have every local test registration
    // alert a mailbox.
    expect(notificationConfig().channels.email).toBe(false);
    expect(notificationConfig().channels.console).toBe(true);
  });

  it('splits the recipients, so a comma separated list is several addresses', () => {
    process.env.NOTIFICATION_EMAIL_TO = 'ops@example.com, oncall@example.com';

    expect(notificationConfig().email.to).toEqual([
      'ops@example.com',
      'oncall@example.com',
    ]);
  });

  it('reads an absent recipient list as empty rather than one blank address', () => {
    // A single "" would be sent to as a recipient, and the failure would look like a
    // provider problem rather than a missing variable.
    expect(notificationConfig().email.to).toEqual([]);
  });
});
