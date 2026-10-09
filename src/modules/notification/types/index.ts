import type { NotificationChannelName } from '../../../configs/notification.config.js';
import type { NotificationEventKey } from '../notification.events.js';

/** What one channel did with one notification. */
export interface ChannelDelivery {
  channel: NotificationChannelName;
  delivered: boolean;
  /** True when the recipient had muted this event on this channel. */
  skipped?: boolean;
  status?: number;
  error?: string;
  recipient?: string;
  /**
   * How many sends it took, including a muted channel's zero. Required rather than
   * optional because "was it retried" is a question the log row and the dead-letter
   * classification both ask, and an absent answer to it is a wrong one.
   */
  attempts: number;
  /**
   * True when another attempt would be refused the same way. Carried out of the
   * channel so a caller can see the classification without re-deriving it from the
   * status code.
   */
  permanent?: boolean;
}

/** What happened to one notification across every channel. */
export interface DeliveryOutcome {
  /** Groups the log rows for one notification, so a partial delivery is visible. */
  notificationId: string;
  event: NotificationEventKey;
  deliveries: ChannelDelivery[];
  /**
   * True when nothing was attempted, because notifications are off or no channel is
   * enabled. Not an error: a deployment with the master switch off has told the
   * application not to send, and the queue must not retry that.
   */
  skipped?: boolean;
}

/** One row's worth of `notification_logs`, before it reaches the repository. */
export interface LogEntry {
  notificationId: string;
  event: NotificationEventKey;
  channel: NotificationChannelName;
  userId?: string;
  delivered: boolean;
  statusCode?: number;
  attempts: number;
  recipient?: string;
  body?: string;
  error?: string;
}
