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

export interface DomainEventDataI {
  'user.registered': { email: string; firstName?: string };
  'user.deleted': { email: string; actor: string };
  'user.updated': { email: string; changes: Record<string, unknown> };
  'auth.login': { email: string; ip?: string; userAgent?: string };
  'auth.logout': { userId: string };
  'auth.token_refreshed': { userId: string; previousTokenVersion: number };
  'mail.template.created': { templateId: string; name: string };
  'mail.template.updated': { templateId: string; name: string };
  'mail sent': { templateId: string; recipient: string; sentAt: string };
  'mail.logentry.created': {
    messageId: string;
    status: 'sent' | 'failed' | 'delayed';
  };
  'job.enqueued': {
    jobId: string;
    queue: string;
    payload: Record<string, unknown>;
  };
  'job.completed': { jobId: string; result: Record<string, unknown> };
  'job.failed': { jobId: string; error: string; retries: number };
  'service.token.created': { subject: string; scopes: string[] };
  'service.token.revoked': { subject: string; reason: string };
  'outbox.published': { aggregate: string; eventId: string };
}

export const domainEventData: DomainEventDataI = {
  'user.registered': { email: 'test@test.com', firstName: 'Test' },
  'user.deleted': { email: 'test@test.com', actor: 'admin' },
  'user.updated': { email: 'test@test.com', changes: { name: 'new' } },
  'auth.login': { email: 'test@test.com', ip: '127.0.0.1', userAgent: 'Test' },
  'auth.logout': { userId: 'user-123' },
  'auth.token_refreshed': { userId: 'user-123', previousTokenVersion: 1 },
  'mail.template.created': { templateId: 'tmpl-1', name: 'Test' },
  'mail.template.updated': { templateId: 'tmpl-1', name: 'Test Updated' },
  'mail sent': {
    templateId: 'tmpl-1',
    recipient: 'test@test.com',
    sentAt: '2024-01-15T10:30:00Z',
  },
  'mail.logentry.created': { messageId: 'msg-1', status: 'sent' },
  'job.enqueued': { jobId: 'job-1', queue: 'default', payload: {} },
  'job.completed': { jobId: 'job-1', result: { success: true } },
  'job.failed': { jobId: 'job-1', error: 'Timeout', retries: 0 },
  'service.token.created': {
    subject: 'user',
    scopes: ['user:read', 'user:write'],
  },
  'service.token.revoked': { subject: 'user', reason: 'Key rotation' },
  'outbox.published': { aggregate: 'user', eventId: 'evt-1' },
};

/**
 * Creates a domain event instance.
 * @param key - The event key
 * @param data - The event data
 * @param perUser - Whether the event is per-user (silenceable by preference)
 * @returns A domain event object with headline and body methods
 */
export function createDomainEvent(
  key: DomainEventKey,
  data: any,
  perUser: boolean = false,
) {
  return {
    key,
    perUser,
    headline: (d: any) => {
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
    body: (d: any) => {
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
