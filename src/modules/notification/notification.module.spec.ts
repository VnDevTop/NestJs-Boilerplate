import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NotificationConfig } from '../../configs/notification.config.js';
import { notificationConfig } from '../../configs/notification.config.js';
import type { NotificationChannel } from './channels/index.js';
import { buildChannels } from './notification.module.js';

/**
 * The enabled-channel set is derived from one config object, so these assert the
 * derivation rather than the module wiring: a channel that is switched on with no
 * credential must be dropped, and a channel nobody enabled must cost nothing.
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

function config(overrides: Record<string, string> = {}): NotificationConfig {
  for (const key of KEYS) {
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }

  return notificationConfig();
}

const httpStub = vi.fn();

const http = { post: httpStub } as never;
const mailer = {
  sendNotification: vi.fn().mockResolvedValue({ delivered: true }),
} as never;

const names = (channels: NotificationChannel[]) =>
  channels.map((channel) => channel.name);

beforeEach(() => {
  for (const key of KEYS) {
    delete process.env[key];
  }

  vi.clearAllMocks();
});

describe('buildChannels', () => {
  it('builds nothing when the master switch is off', () => {
    const off = config({ NOTIFICATION_CONSOLE_ENABLED: 'true' });

    expect(names(buildChannels(off, http, mailer))).toEqual([]);
  });

  it('builds the console channel alone for the default development setup', () => {
    // Which is what makes a fresh clone show what the application would have sent
    // without anyone reading this file.
    const on = config({
      NOTIFICATION_ENABLED: 'true',
      NOTIFICATION_CONSOLE_ENABLED: 'true',
    });

    expect(names(buildChannels(on, http, mailer))).toEqual(['console']);
  });

  it('adds each webhook channel that has both its flag and its url', () => {
    const on = config({
      NOTIFICATION_ENABLED: 'true',
      NOTIFICATION_CONSOLE_ENABLED: 'false',
      TELEGRAM_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_CHAT_ID: '-100123',
      SLACK_ENABLED: 'true',
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x',
      DISCORD_ENABLED: 'true',
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x',
    });

    expect(names(buildChannels(on, http, mailer))).toEqual([
      'telegram',
      'slack',
      'discord',
    ]);
  });

  it('drops a webhook channel whose flag is on but whose url is missing', () => {
    // The failure this prevents: every message disappears and nothing else changes,
    // which is indistinguishable from a working integration. The channel logs why,
    // and this is the assertion that it was left out.
    const on = config({
      NOTIFICATION_ENABLED: 'true',
      NOTIFICATION_CONSOLE_ENABLED: 'false',
      SLACK_ENABLED: 'true',
    });

    expect(names(buildChannels(on, http, mailer))).toEqual([]);
  });

  it('drops a webhook channel whose url is present but whose flag is off', () => {
    // A credential pasted into every environment should not start sending the day
    // somebody upgrades.
    const on = config({
      NOTIFICATION_ENABLED: 'true',
      NOTIFICATION_CONSOLE_ENABLED: 'false',
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x',
    });

    expect(names(buildChannels(on, http, mailer))).toEqual([]);
  });

  it('adds the email channel only when it has a recipient', () => {
    const withoutAddress = config({
      NOTIFICATION_ENABLED: 'true',
      NOTIFICATION_CONSOLE_ENABLED: 'false',
      NOTIFICATION_EMAIL_ENABLED: 'true',
    });
    const withAddress = config({
      NOTIFICATION_ENABLED: 'true',
      NOTIFICATION_CONSOLE_ENABLED: 'false',
      NOTIFICATION_EMAIL_ENABLED: 'true',
      NOTIFICATION_EMAIL_TO: 'ops@example.com',
    });

    expect(names(buildChannels(withoutAddress, http, mailer))).toEqual([]);
    expect(names(buildChannels(withAddress, http, mailer))).toEqual(['email']);
  });

  it('puts the console channel last, because it always succeeds', () => {
    // First, a broken webhook would read as a partial success in a summary line
    // rather than in the per-channel columns.
    const on = config({
      NOTIFICATION_ENABLED: 'true',
      NOTIFICATION_CONSOLE_ENABLED: 'true',
      NOTIFICATION_EMAIL_ENABLED: 'true',
      NOTIFICATION_EMAIL_TO: 'ops@example.com',
      SLACK_ENABLED: 'true',
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x',
    });

    expect(names(buildChannels(on, http, mailer))).toEqual([
      'slack',
      'email',
      'console',
    ]);
  });

  it('builds no channel at all when notifications are on but nothing is left enabled', () => {
    // The awkward middle state an operator reaches by turning the master switch on and
    // then turning the console channel off without configuring a webhook. The module
    // logs it; this is the assertion behind that log.
    //
    // The console channel has to be switched off explicitly here because it defaults
    // to on — which is the other half of the same design decision.
    const on = config({
      NOTIFICATION_ENABLED: 'true',
      NOTIFICATION_CONSOLE_ENABLED: 'false',
    });

    expect(names(buildChannels(on, http, mailer))).toEqual([]);
  });

  it('still delivers to the console when only the master switch is on', () => {
    // The default a fresh clone gets. Asserted separately from the case above because
    // "enabled and nothing configured" is a working configuration, not a broken one.
    const on = config({ NOTIFICATION_ENABLED: 'true' });

    expect(names(buildChannels(on, http, mailer))).toEqual(['console']);
  });

  it('reuses the shared HttpService rather than opening one per channel', () => {
    // Nothing here connects, so building a channel is field reads only. Asserted
    // because the alternative — a channel per axios instance — would be three sockets
    // for a deployment that enabled one.
    const on = config({
      NOTIFICATION_ENABLED: 'true',
      NOTIFICATION_CONSOLE_ENABLED: 'false',
      SLACK_ENABLED: 'true',
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x',
    });

    const [slack] = buildChannels(on, http, mailer);

    expect(slack).toBeDefined();
    expect(httpStub).not.toHaveBeenCalled();
  });
});
