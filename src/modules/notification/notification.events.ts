/**
 * The events a notification can carry, and the text each one produces.
 *
 * Plain functions in a plain registry, for the same reason the mail templates are
 * in Phase 14: a template engine is a runtime dependency and an admin surface, and
 * neither belongs in the phase whose job is to make a message arrive somewhere.
 * Phase 22 is where that trade gets revisited.
 *
 * **Every event takes exactly the fields it interpolates.** No signature here
 * mentions a user entity or an ORM row, and that is the point rather than an
 * accident of style: an event that *can* read `user.password` is one refactor away
 * from posting a credential to a shared Slack channel, and the type is what stops
 * it rather than a code review.
 *
 * The keys are dotted and namespaced by subject, matching the permission names from
 * Phase 17a. They are the column value in `notification_logs`, the value in
 * `notification_preferences.event`, and the key in `TELEGRAM_TOPICS`, so the
 * spelling is chosen once and used everywhere.
 */

export type NotificationEventKey =
  | 'user.registered'
  | 'user.deleted'
  | 'auth.login.failed'
  | 'auth.device.login'
  | 'auth.2fa.enabled'
  | 'auth.2fa.disabled'
  | 'maintenance.retention.anomaly';

export interface NotificationEvent<TData> {
  readonly key: NotificationEventKey;
  /**
   * One-line headline. Slack and Discord render it as a bold block, Telegram puts
   * it on the first line, and the email channel uses it as the subject, so it has
   * to stand alone without the body.
   */
  headline(data: TData): string;
  /**
   * The body. Plain text with `\n` line breaks and no markup: Slack's `mrkdwn` and
   * Telegram's MarkdownV2 need different escaping and neither is a superset of the
   * other, so a body carrying formatting for one channel renders as literal
   * punctuation in the other. Plain text is the only format every channel here
   * reads correctly.
   */
  body(data: TData): string;
  /**
   * Whether this event is about a specific user, which decides two things: whether
   * a preference row can silence it, and whether `notification_logs.userId` is set.
   *
   * False for the retention anomaly, which is a fact about the deployment. A
   * preference lookup for it would find nothing and answer the same either way, so
   * the flag is about honesty in the log rather than about behaviour.
   */
  readonly perUser: boolean;
}

// The data each event is given, keyed by event. Adding an event without adding its
// data here is a type error at the call site, which is the enforcement.

export interface UserRegisteredData {
  email: string;
  firstName: string;
}

export interface UserDeletedData {
  email: string;
  /** Who asked, so an operator can tell an admin action from a stray script. */
  actor: string;
}

export interface LoginFailedData {
  email: string;
  /** Failures counted so far, which is what turns "one wrong password" into news. */
  failures: number;
  /** Minutes the account is blocked for, or zero when it was not blocked. */
  blockedMinutes: number;
}

export interface DeviceLoginData {
  email: string;
  deviceName: string;
  ip: string;
  time: string;
}

export interface TwoFactorData {
  email: string;
}

export interface RetentionAnomalyData {
  /** What went wrong, in the words the retention service used. */
  reason: string;
  /** Targets that never ran, which is the part an operator has to act on. */
  pending: string[];
  /** Targets that raised an error. */
  failed: string[];
  durationMs: number;
}

export interface NotificationEventData {
  'user.registered': UserRegisteredData;
  'user.deleted': UserDeletedData;
  'auth.login.failed': LoginFailedData;
  'auth.device.login': DeviceLoginData;
  'auth.2fa.enabled': TwoFactorData;
  'auth.2fa.disabled': TwoFactorData;
  'maintenance.retention.anomaly': RetentionAnomalyData;
}

/** Trims a value the same way everywhere, so an empty field reads as "unknown". */
const or = (value: string, fallback: string): string => {
  const trimmed = value.trim();

  return trimmed === '' ? fallback : trimmed;
};

const minutes = (ms: number): string => {
  const total = Math.max(1, Math.ceil(ms / 60_000));

  return `${total} minute${total === 1 ? '' : 's'}`;
};

export const userRegisteredEvent: NotificationEvent<UserRegisteredData> = {
  key: 'user.registered',
  perUser: true,
  headline: ({ email }) => `New account: ${or(email, 'unknown address')}`,
  body: ({ email, firstName }) =>
    [
      `Address: ${or(email, 'unknown')}`,
      `Name: ${or(firstName, 'not given')}`,
      'This account has not verified its email address yet.',
    ].join('\n'),
};

export const userDeletedEvent: NotificationEvent<UserDeletedData> = {
  key: 'user.deleted',
  perUser: true,
  headline: ({ email }) => `Account deleted: ${or(email, 'unknown address')}`,
  body: ({ email, actor }) =>
    [
      `Address: ${or(email, 'unknown')}`,
      `Deleted by: ${or(actor, 'unknown')}`,
    ].join('\n'),
};

export const loginFailedEvent: NotificationEvent<LoginFailedData> = {
  key: 'auth.login.failed',
  perUser: true,
  headline: ({ blockedMinutes }) =>
    blockedMinutes > 0
      ? `Sign-in blocked for ${minutes(blockedMinutes * 60_000)}`
      : 'Repeated failed sign-in attempts',
  body: ({ email, failures, blockedMinutes }) =>
    [
      `Address: ${or(email, 'unknown')}`,
      `Failed attempts: ${failures}`,
      blockedMinutes > 0
        ? `Blocked for ${minutes(blockedMinutes * 60_000)}`
        : 'Not blocked yet.',
    ].join('\n'),
};

export const deviceLoginEvent: NotificationEvent<DeviceLoginData> = {
  key: 'auth.device.login',
  perUser: true,
  headline: ({ deviceName }) =>
    `Sign-in from a new device: ${or(deviceName, 'unrecognised device')}`,
  body: ({ email, deviceName, ip, time }) =>
    [
      `Address: ${or(email, 'unknown')}`,
      `Device: ${or(deviceName, 'unrecognised')}`,
      `From: ${or(ip, 'unknown')}`,
      `At: ${or(time, 'unknown')}`,
    ].join('\n'),
};

export const twoFactorEnabledEvent: NotificationEvent<TwoFactorData> = {
  key: 'auth.2fa.enabled',
  perUser: true,
  headline: ({ email }) =>
    `Two-factor enabled: ${or(email, 'unknown address')}`,
  body: ({ email }) =>
    [
      `Address: ${or(email, 'unknown')}`,
      'The account now requires a second factor at sign-in.',
    ].join('\n'),
};

export const twoFactorDisabledEvent: NotificationEvent<TwoFactorData> = {
  key: 'auth.2fa.disabled',
  perUser: true,
  headline: ({ email }) =>
    `Two-factor disabled: ${or(email, 'unknown address')}`,
  body: ({ email }) =>
    [
      `Address: ${or(email, 'unknown')}`,
      'The account no longer requires a second factor at sign-in.',
    ].join('\n'),
};

export const retentionAnomalyEvent: NotificationEvent<RetentionAnomalyData> = {
  key: 'maintenance.retention.anomaly',
  perUser: false,
  headline: () => 'Retention run did not finish cleanly',
  body: ({ reason, pending, failed, durationMs }) =>
    [
      `Reason: ${or(reason, 'not recorded')}`,
      `Duration: ${Math.round(durationMs / 1000)}s`,
      pending.length > 0 ? `Not reached: ${pending.join(', ')}` : null,
      failed.length > 0 ? `Failed: ${failed.join(', ')}` : null,
    ]
      .filter((line): line is string => line !== null)
      .join('\n'),
};

const registry: {
  [K in NotificationEventKey]: NotificationEvent<NotificationEventData[K]>;
} = {
  'user.registered': userRegisteredEvent,
  'user.deleted': userDeletedEvent,
  'auth.login.failed': loginFailedEvent,
  'auth.device.login': deviceLoginEvent,
  'auth.2fa.enabled': twoFactorEnabledEvent,
  'auth.2fa.disabled': twoFactorDisabledEvent,
  'maintenance.retention.anomaly': retentionAnomalyEvent,
};

/** Every event name, in the order an operator would read them. */
export const NOTIFICATION_EVENT_KEYS = Object.keys(
  registry,
) as NotificationEventKey[];

/**
 * Narrowing for data arriving from a queue payload or an HTTP body.
 *
 * **`Object.hasOwn` rather than `in`.** `in` walks the prototype chain, so a
 * payload carrying `"constructor"`, `"toString"` or `"__proto__"` would pass the
 * guard and then be looked up in the registry as a function rather than as an
 * event. The value is untrusted — it comes off a queue and out of an HTTP body —
 * so this is the difference between a rejected payload and a crash inside a job.
 */
export function isNotificationEventKey(
  value: unknown,
): value is NotificationEventKey {
  return typeof value === 'string' && Object.hasOwn(registry, value);
}

/**
 * Renders an event by name.
 *
 * A registry lookup rather than a switch, so adding an event is adding an entry.
 * The generic ties the data to the key at every call site, which is what stops
 * `auth.2fa.enabled` being handed `UserRegisteredData`: the fields overlap enough
 * that the wrong pairing would compile.
 */
export function renderNotification<TKey extends NotificationEventKey>(
  key: TKey,
  data: NotificationEventData[TKey],
): { headline: string; body: string } {
  const event = registry[key];

  return { headline: event.headline(data), body: event.body(data) };
}
