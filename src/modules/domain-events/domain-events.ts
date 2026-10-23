/**
 * Domain event keys, keyed by aggregate root.
 * Each key is a dotted, namespaced string following the format:
 * `aggregate.eventName`
 *
 * These keys are used across the system:
 * - As the `event` column in event store tables
 * - As the `event` column in notification_logs
 * - As the key in preference silencing
 * - As the topic name in message queues
 *
 * The spelling is chosen once and used everywhere, so adding a new event
 * requires updating only this file.
 */

export type DomainEventKey =
  | 'user.registered'
  | 'user.deleted'
  | 'user.updated'
  | 'auth.login'
  | 'auth.logout'
  | 'auth.token_refreshed'
  | 'mail.template.created'
  | 'mail.template.updated'
  | 'mail sent'
  | 'mail.logentry.created'
  | 'job.enqueued'
  | 'job.completed'
  | 'job.failed'
  | 'service.token.created'
  | 'service.token.revoked'
  | 'outbox.published';

/**
 * The domain event interface.
 * Every event must implement `headline` and `body` methods that take the event's
 * data and return a string. The `key` identifies the event type, and `perUser`
 * decides whether the event is silenced per user or globally.
 */

export interface DomainEvent<Data = unknown> {
  readonly key: DomainEventKey;
  readonly perUser: boolean;

  /**
   * One-line headline. Used by channels for the main display text.
   */
  headline(data: Data): string;

  /**
   * The body. Plain text with `\n` line breaks.
   */
  body(data: Data): string;
}

/**
 * Data interfaces for each domain event, keyed by `DomainEventKey`.
 * Adding a new event requires adding its data interface here and extending
 * the `DomainEventKey` union type.
 */

export interface UserRegisteredData {
  email: string;
  firstName: '' | undefined;
}

export interface UserDeletedData {
  email: string;
  actor: string;
}

export interface UserUpdatedData {
  email: string;
  changes: Record<string, unknown>;
}

export interface AuthLoginData {
  email: string;
  ip: '' | undefined;
  userAgent: '' | undefined;
}

export interface AuthLogoutData {
  userId: string;
}

export interface AuthTokenRefreshedData {
  userId: string;
  previousTokenVersion: number;
}

export interface MailTemplateCreatedData {
  templateId: string;
  name: string;
}

export interface MailTemplateUpdatedData {
  templateId: string;
  name: string;
}

export interface MailSentData {
  templateId: string;
  recipient: string;
  sentAt: string;
}

export interface MailLogentryCreatedData {
  messageId: string;
  status: 'sent' | 'failed' | 'delayed';
}

export interface JobEnqueuedData {
  jobId: string;
  queue: string;
  payload: Record<string, unknown>;
}

export interface JobCompletedData {
  jobId: string;
  result: Record<string, unknown>;
}

export interface JobFailedData {
  jobId: string;
  error: string;
  retries: number;
}

export interface ServiceTokenCreatedData {
  subject: string;
  scopes: string[];
}

export interface ServiceTokenRevokedData {
  subject: string;
  reason: string;
}

export interface OutboxPublishedData {
  aggregate: string;
  eventId: string;
}

/**
 * Maps each `DomainEventKey` to its corresponding data interface.
 * This is enforced at the type system level: adding a new key without adding
 * its data interface is a TypeScript error at the call site.
 */

/**
 * Domain event data interfaces, mapped by event key.
 * This is both a type (for compile-time safety) and a runtime object.
 * Adding a new event requires:
 * 1. Adding its data interface above
 * 2. Adding its entry here
 * 3. Adding the key to DomainEventKey union
 * 4. Adding its headline/body in createDomainEvent
 */

export const DomainEventData: Record<
  DomainEventKey,
  Record<string, unknown>
> = {
  'user.registered': { email: '', firstName: '' },
  'user.deleted': { email: '', actor: '' },
  'user.updated': { email: '', changes: {} },
  'auth.login': { email: '', ip: '', userAgent: '' },
  'auth.logout': { userId: '' },
  'auth.token_refreshed': { userId: '', previousTokenVersion: 0 },
  'mail.template.created': { templateId: '', name: '' },
  'mail.template.updated': { templateId: '', name: '' },
  'mail sent': { templateId: '', recipient: '', sentAt: '' },
  'mail.logentry.created': {
    messageId: '',
    status: 'sent' as 'sent' | 'failed' | 'delayed',
  },
  'job.enqueued': { jobId: '', queue: '', payload: {} },
  'job.completed': { jobId: '', result: {} },
  'job.failed': { jobId: '', error: '', retries: 0 },
  'service.token.created': { subject: '', scopes: [] },
  'service.token.revoked': { subject: '', reason: '' },
  'outbox.published': { aggregate: '', eventId: '' },
};

/**
 * Creates a domain event instance.
 * This is a factory function that ensures the correct key and data types are used.
 */

export function createDomainEvent<Data extends keyof DomainEventData>(
  key: Data,
  data: DomainEventData[Data],
  perUser: boolean = false,
): DomainEvent<DomainEventData[Data]> {
  return {
    key,
    perUser,
    headline: (d: DomainEventData[Data]) => {
      switch (key) {
        case 'user.registered':
          return `User registered: ${d.email}`;
        case 'user.deleted':
          return `User deleted: ${d.email}`;
        case 'user.updated':
          return `User updated: ${d.email}`;
        case 'auth.login':
          return `User logged in: ${d.email}`;
        case 'auth.logout':
          return `User logged out: ${d.userId}`;
        case 'auth.token_refreshed':
          return `Token refreshed for user: ${d.userId}`;
        case 'mail.template.created':
          return `Mail template created: ${d.name}`;
        case 'mail.template.updated':
          return `Mail template updated: ${d.name}`;
        case 'mail sent':
          return `Mail sent to: ${d.recipient}`;
        case 'mail.logentry.created':
          return `Mail log entry created: ${d.messageId}`;
        case 'job.enqueued':
          return `Job enqueued: ${d.jobId}`;
        case 'job.completed':
          return `Job completed: ${d.jobId}`;
        case 'job.failed':
          return `Job failed: ${d.jobId}`;
        case 'service.token.created':
          return `Service token created for: ${d.subject}`;
        case 'service.token.revoked':
          return `Service token revoked: ${d.subject}`;
        case 'outbox.published':
          return `Outbox published for: ${d.aggregate}`;
        default:
          return 'Domain event';
      }
    },
    body: (d: DomainEventData[Data]) => {
      switch (key) {
        case 'user.registered':
          return `User ${d.email} has been registered`;
        case 'user.deleted':
          return `User ${d.email} has been deleted by ${d.actor}`;
        case 'user.updated':
          return `User ${d.email} has been updated with changes: ${JSON.stringify(
            d.changes,
          )}`;
        case 'auth.login':
          return `User ${d.email} logged in from ${d.ip} (${d.userAgent?.substring(0, 40) || 'unknown client'})`;
        case 'auth.logout':
          return `User ${d.userId} has logged out`;
        case 'auth.token_refreshed':
          return `Token refreshed for user ${d.userId}, previous version: ${d.previousTokenVersion}`;
        case 'mail.template.created':
          return `Mail template "${d.name}" (${d.templateId}) has been created`;
        case 'mail.template.updated':
          return `Mail template "${d.name}" (${d.templateId}) has been updated`;
        case 'mail sent':
          return `Mail sent at ${d.sentAt} to ${d.recipient} using template ${d.templateId}`;
        case 'mail.logentry.created':
          return `Mail log entry ${d.messageId} status: ${d.status}`;
        case 'job.enqueued':
          return `Job ${d.jobId} enqueued to queue ${d.queue} with payload ${JSON.stringify(
            d.payload,
          )}`;
        case 'job.completed':
          return `Job ${d.jobId} completed with result ${JSON.stringify(d.result)}`;
        case 'job.failed':
          return `Job ${d.jobId} failed: ${d.error}. Retries: ${d.retries}`;
        case 'service.token.created':
          return `Service token created for subject: ${d.subject} with scopes: ${d.scopes.join(', ')}`;
        case 'service.token.revoked':
          return `Service token revoked for subject: ${d.subject}, reason: ${d.reason}`;
        case 'outbox.published':
          return `Outbox published for aggregate: ${d.aggregate}, event ID: ${d.eventId}`;
        default:
          return 'Domain event body';
      }
    },
  };
}
