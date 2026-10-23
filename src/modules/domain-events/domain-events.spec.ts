import {
  DomainEventKey,
  domainEventData,
  createDomainEvent,
} from './domain-events.js';

describe('DomainEvent', () => {
  describe('DomainEventKey', () => {
    it('contains all expected event keys', () => {
      const keys: DomainEventKey[] = [
        'user.registered',
        'user.deleted',
        'user.updated',
        'auth.login',
        'auth.logout',
        'auth.token_refreshed',
        'mail.template.created',
        'mail.template.updated',
        'mail sent',
        'mail.logentry.created',
        'job.enqueued',
        'job.completed',
        'job.failed',
        'service.token.created',
        'service.token.revoked',
        'outbox.published',
      ];

      expect(keys.length).toBe(16);
    });

    it('each key is a string', () => {
      const keys: DomainEventKey[] = ['user.registered', 'user.deleted'];

      keys.forEach((key) => {
        expect(typeof key).toBe('string');
      });
    });
  });

  describe('domainEventData', () => {
    it('has data for each key', () => {
      const keys: DomainEventKey[] = [
        'user.registered',
        'user.deleted',
        'auth.login',
        'auth.logout',
        'mail sent',
        'job.completed',
        'service.token.created',
        'outbox.published',
      ] as DomainEventKey[];

      keys.forEach((key) => {
        expect(domainEventData[key]).toBeDefined();
      });
    });
  });

  describe('createDomainEvent', () => {
    it('creates a user.registered event', () => {
      const event = createDomainEvent('user.registered', {
        email: 'test@example.com',
        firstName: 'Test',
      });

      expect(event.key).toBe('user.registered');
      expect(event.perUser).toBe(false);
      expect(
        event.headline({ email: 'test@example.com', firstName: 'Test' }),
      ).toBe('User registered: test@example.com');
      expect(event.body({ email: 'test@example.com', firstName: 'Test' })).toBe(
        'User test@example.com has been registered',
      );
    });

    it('creates a user.deleted event', () => {
      const event = createDomainEvent('user.deleted', {
        email: 'test@example.com',
        actor: 'admin',
      });

      expect(event.key).toBe('user.deleted');
      expect(
        event.headline({ email: 'test@example.com', actor: 'admin' }),
      ).toBe('User deleted: test@example.com');
      expect(event.body({ email: 'test@example.com', actor: 'admin' })).toBe(
        'User test@example.com has been deleted by admin',
      );
    });

    it('creates an auth.login event', () => {
      const event = createDomainEvent('auth.login', {
        email: 'test@example.com',
        ip: '127.0.0.1',
        userAgent: 'Mozilla/5.0',
      });

      expect(event.key).toBe('auth.login');
      expect(
        event.headline({
          email: 'test@example.com',
          ip: '127.0.0.1',
          userAgent: 'Mozilla/5.0',
        }),
      ).toBe('User logged in: test@example.com');
    });

    it('creates a mail sent event', () => {
      const event = createDomainEvent('mail sent', {
        templateId: 'welcome',
        recipient: 'user@example.com',
        sentAt: '2024-01-15T10:30:00Z',
      });

      expect(event.key).toBe('mail sent');
      expect(
        event.headline({
          templateId: 'welcome',
          recipient: 'user@example.com',
          sentAt: '2024-01-15T10:30:00Z',
        }),
      ).toBe('Mail sent to: user@example.com');
    });

    it('creates a job completed event', () => {
      const event = createDomainEvent('job.completed', {
        jobId: 'import-123',
        result: { rowsProcessed: 100, success: true },
      });

      expect(event.key).toBe('job.completed');
      expect(
        event.body({
          jobId: 'import-123',
          result: { rowsProcessed: 100, success: true },
        }),
      ).toBe(
        'Job import-123 completed with result {"rowsProcessed":100,"success":true}',
      );
    });

    it('creates a service token created event', () => {
      const event = createDomainEvent('service.token.created', {
        subject: 'user',
        scopes: ['user:read', 'user:write'],
      });

      expect(event.key).toBe('service.token.created');
      expect(
        event.headline({
          subject: 'user',
          scopes: ['user:read', 'user:write'],
        }),
      ).toBe('Service token created for: user');
    });

    it('creates an outbox published event', () => {
      const event = createDomainEvent('outbox.published', {
        aggregate: 'user',
        eventId: 'evt-123',
      });

      expect(event.key).toBe('outbox.published');
      expect(event.headline({ aggregate: 'user', eventId: 'evt-123' })).toBe(
        'Outbox published for: user',
      );
    });
  });
});
