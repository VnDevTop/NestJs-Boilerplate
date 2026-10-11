import { registerAs } from '@nestjs/config';

/**
 * Notification settings.
 *
 * Not exported from `configs/index.ts` and not in the `load` array of
 * `app.module.ts`, for the same reason as `mail.config.ts`: it describes
 * optional channels, so it is loaded with `ConfigModule.forFeature()` inside
 * `NotificationModule`.
 *
 * No channel here needs a package. Telegram, Slack and Discord are reached over
 * HTTPS, and the email channel delegates to `MailService`, which is already here.
 * So this namespace is pure configuration and nothing more.
 */

export type NotificationChannelName =
  'console' | 'email' | 'telegram' | 'slack' | 'discord';

export interface NotificationConfig {
  /**
   * Master switch. When false every channel is skipped, whatever its own flag
   * says, so an incident can silence notifications without editing five
   * variables.
   */
  enabled: boolean;
  /** Per-channel switches, checked alongside the master switch. */
  channels: Record<NotificationChannelName, boolean>;
  telegram: TelegramOptions;
  slack: SlackOptions;
  discord: DiscordOptions;
  email: EmailOptions;
  /** Delivery behaviour, applied to every channel. */
  delivery: NotificationDeliveryOptions;
}

/** Mirrors the fields the Telegram channel passes to the Bot API. */
export interface TelegramOptions {
  botToken?: string;
  chatId?: string;
  /**
   * Forum topic id, so one bot can route event types to separate rooms. A
   * single chat without topics needs no value here.
   */
  topicId?: string;
  /**
   * Per-event topic ids, which override `topicId` for the events they name.
   *
   * A separate map rather than one id per channel because a forum chat is
   * usually several rooms: security events are worth their own topic so they are
   * not buried under routine registration chatter, and putting them in a
   * different chat means a second bot token.
   *
   * Parsed from `event=topicId` pairs rather than one variable per event, so a
   * new event does not need a new variable in three files. A pair naming an event
   * with no entry here falls back to `topicId`, and an unparsable pair is dropped
   * rather than failing the boot: the notification still arrives, in the room
   * every other event uses.
   */
  topics: Record<string, string>;
}

/** Mirrors the fields the Slack channel posts to an incoming webhook. */
export interface SlackOptions {
  /** The incoming webhook url, which already carries the credential. */
  webhookUrl?: string;
  /** Label used in log lines, so a failure names the destination. */
  channel?: string;
}

/** Mirrors the fields the Discord webhook accepts, which is Slack's shape. */
export interface DiscordOptions {
  webhookUrl?: string;
  channel?: string;
}

export interface EmailOptions {
  /**
   * Where the email channel sends. Comma separated, because an operator with a
   * shared mailbox and a personal one wants both.
   */
  to: string[];
}

export interface NotificationDeliveryOptions {
  /** How long to wait for a webhook, in milliseconds. */
  timeout: number;
  /**
   * How many times to retry a delivery. A broken webhook is retried rather than
   * dropped, because a notification is only useful if it arrives.
   */
  retries: number;
  /**
   * Base for the exponential backoff between retries, in milliseconds. The
   * wait before attempt N is this value times 2^(N-1).
   */
  retryDelay: number;
  /**
   * Whether a failed delivery is fatal. Off in practice: a broken webhook must
   * never fail the request that triggered it.
   */
  throwOnFailure: boolean;
}

const flag = (value: string | undefined, fallback = false): boolean =>
  value === undefined ? fallback : value === 'true';

/**
 * `user.registered=42,auth.login.failed=43` into `{ 'user.registered': '42', ... }`.
 *
 * A malformed pair is skipped rather than throwing. A boot that fails over a typo
 * in a routing convenience is a worse outcome than a notification arriving in the
 * default room, and the reason the pair was dropped is on the config's own shape:
 * it simply has no entry.
 */
export function parseTopicRoutes(
  raw: string | undefined,
): Record<string, string> {
  const routes: Record<string, string> = {};

  if (raw === undefined || raw.trim() === '') {
    return routes;
  }

  for (const pair of raw.split(',')) {
    const separator = pair.indexOf('=');

    if (separator < 1) {
      continue;
    }

    const event = pair.slice(0, separator).trim();
    const topicId = pair.slice(separator + 1).trim();

    if (event !== '' && topicId !== '') {
      routes[event] = topicId;
    }
  }

  return routes;
}

const addresses = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');

export const notificationConfig = registerAs(
  'notification',
  (): NotificationConfig => ({
    enabled: flag(process.env.NOTIFICATION_ENABLED),
    channels: {
      // The console channel is the development default, so a fresh clone shows
      // what the app would have sent.
      console: flag(process.env.NOTIFICATION_CONSOLE_ENABLED, true),
      // Off by default even though the console channel is on: mail is the
      // expensive one, and a developer running locally with a real SMTP
      // credential in their environment should not have every test registration
      // send an operator alert.
      email: flag(process.env.NOTIFICATION_EMAIL_ENABLED),
      telegram: flag(process.env.TELEGRAM_ENABLED),
      slack: flag(process.env.SLACK_ENABLED),
      discord: flag(process.env.DISCORD_ENABLED),
    },
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
      topicId: process.env.TELEGRAM_TOPIC_ID,
      topics: parseTopicRoutes(process.env.TELEGRAM_TOPICS),
    },
    slack: {
      webhookUrl: process.env.SLACK_WEBHOOK_URL,
      channel: process.env.SLACK_CHANNEL,
    },
    discord: {
      webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      channel: process.env.DISCORD_CHANNEL,
    },
    email: {
      to: addresses(process.env.NOTIFICATION_EMAIL_TO),
    },
    delivery: {
      timeout: Number(process.env.NOTIFICATION_TIMEOUT ?? 5_000),
      retries: Number(process.env.NOTIFICATION_RETRIES ?? 2),
      retryDelay: Number(process.env.NOTIFICATION_RETRY_DELAY ?? 1_000),
      throwOnFailure: flag(process.env.NOTIFICATION_THROW_ON_FAILURE),
    },
  }),
);
