import type {
  NotificationChannelName,
  NotificationConfig,
} from '../../../configs/notification.config.js';
import type { NotificationEventKey } from '../notification.events.js';

/**
 * What a channel is asked to deliver.
 *
 * Already rendered. A channel formats, it does not decide what a message says:
 * two channels rendering the same event independently is how the Slack copy and
 * the Telegram copy drift into saying different things about the same incident,
 * and the operator reading the second one cannot tell which is authoritative.
 *
 * The text is plain, with `\n` breaks and no markup. Slack's `mrkdwn`, Telegram's
 * MarkdownV2 and Discord's markdown are three different escaping rules with no
 * common subset a sender could target, so a body carrying formatting for one reads
 * as literal punctuation in the others. Telegram's own escaper is applied by that
 * channel rather than here, for the same reason.
 */
export interface NotificationPayload {
  event: NotificationEventKey;
  /** One-line headline, rendered by the event registry. */
  headline: string;
  /** The body, rendered by the event registry. */
  body: string;
  /**
   * The user this is about, when it is about one. A channel that can address a
   * person uses it; the delivery log records it so an operator can filter.
   */
  userId?: string;
}

export interface ChannelResult {
  delivered: boolean;
  status?: number;
  /**
   * True when another attempt would be refused the same way, so the retry budget
   * is not spent on a credential that was revoked an hour ago.
   */
  permanent?: boolean;
  error?: string;
  /** Where it went, recorded in `notification_logs`. */
  recipient?: string;
  /** How many attempts it took, including the successful one. */
  attempts?: number;
}

/**
 * The whole extension story.
 *
 * A channel is a name, an enabled check and a send. A third party adds one by
 * providing a class with this shape and listing it in `selectChannels`; nothing in
 * the service changes. That is the property the plan asks for, and it is the reason
 * there is no `if (channel === 'telegram')` in the delivery path.
 *
 * `isEnabled()` rather than a boolean handed in, because "enabled" is three things
 * at once — the master switch, the per-channel flag, and whether the channel has
 * the credential it needs — and a channel is the only one that knows the third. A
 * channel switched on with no webhook url drops every message while looking exactly
 * like a working integration, so it answers false and says why.
 *
 * `send` returns rather than throws on a provider refusal and lets a network
 * failure reject. That asymmetry is deliberate and matches `postJson`: a 4xx is a
 * fact to record and stop retrying, a socket error is worth another attempt.
 */
export interface NotificationChannel {
  readonly name: NotificationChannelName;
  isEnabled(): boolean;
  send(payload: NotificationPayload): Promise<ChannelResult>;
}

/**
 * Classifies a provider status.
 *
 * Shared by every webhook channel rather than repeated in each, because this
 * distinction is the one thing that decides whether a dead credential costs three
 * attempts or thirty.
 */
export function isPermanentStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500;
}

/** Applies both switches, in the order an operator would expect. */
export function channelFlag(
  config: NotificationConfig,
  name: NotificationChannelName,
): boolean {
  return config.enabled && config.channels[name];
}
