import { describe, expect, it } from 'vitest';

import { escapeSlackMarkdown } from '../../core/optional/transports/slack.channel.js';
import { escapeMarkdownV2 } from '../../core/optional/transports/telegram.channel.js';
import {
  deviceLoginEvent,
  isNotificationEventKey,
  type NotificationEventData,
  type NotificationEventKey,
  loginFailedEvent,
  NOTIFICATION_EVENT_KEYS,
  renderNotification,
  retentionAnomalyEvent,
  twoFactorDisabledEvent,
  twoFactorEnabledEvent,
  userDeletedEvent,
  userRegisteredEvent,
} from './notification.events.js';

/**
 * The registry is the only place an event's wording lives, and every channel reads
 * it. So the properties worth defending are that it renders without throwing for
 * each of its own data, and that a hostile value cannot break the markup.
 */

describe('the event registry', () => {
  it('names every event the plan lists, and no others', () => {
    // Written out rather than compared against the registry, because a registry that
    // lost an entry would otherwise agree with itself.
    expect([...NOTIFICATION_EVENT_KEYS].sort()).toEqual([
      'auth.2fa.disabled',
      'auth.2fa.enabled',
      'auth.device.login',
      'auth.login.failed',
      'maintenance.retention.anomaly',
      'user.deleted',
      'user.registered',
    ]);
  });

  it('recognises a known event and rejects anything else', () => {
    expect(isNotificationEventKey('user.registered')).toBe(true);
    expect(isNotificationEventKey('user.exploded')).toBe(false);
    expect(isNotificationEventKey('')).toBe(false);
    // A payload from a queue is untrusted, so the guard has to survive a non-string.
    expect(isNotificationEventKey(undefined)).toBe(false);
    expect(isNotificationEventKey(42)).toBe(false);
    expect(isNotificationEventKey({ event: 'user.registered' })).toBe(false);
  });

  it('rejects a name that only looks like one, because it is a registry lookup', () => {
    // `in` would answer true for anything on the prototype chain, so a payload
    // carrying `constructor` would be treated as a real event and rendered.
    expect(isNotificationEventKey('constructor')).toBe(false);
    expect(isNotificationEventKey('toString')).toBe(false);
    expect(isNotificationEventKey('__proto__')).toBe(false);
  });
});

describe('user.registered', () => {
  it('names the address in the headline so a channel shows it without the body', () => {
    // Slack and Discord render the headline as a bold block above the body, and an
    // operator scanning the channel reads that line only.
    expect(
      userRegisteredEvent.headline({
        email: 'ada@example.com',
        firstName: 'Ada',
      }),
    ).toContain('ada@example.com');
  });

  it('says the address is unverified, because that is what matters at that moment', () => {
    const { body } = renderNotification('user.registered', {
      email: 'ada@example.com',
      firstName: 'Ada',
    });

    expect(body).toContain('not verified');
  });

  it('renders an empty name without saying "Name: null"', () => {
    const { body } = renderNotification('user.registered', {
      email: 'ada@example.com',
      firstName: '',
    });

    expect(body).toContain('Name: not given');
    expect(body).not.toContain('null');
  });

  it('renders an empty address rather than posting a blank headline', () => {
    // The database rejects a blank address, so this is unreachable — which is
    // exactly why it needs a fallback: a rendering that throws inside a job turns a
    // hypothetical into a dead-letter entry.
    const { headline, body } = renderNotification('user.registered', {
      email: '   ',
      firstName: 'Ada',
    });

    expect(headline).toContain('unknown');
    expect(body).toContain('unknown');
  });
});

describe('user.deleted', () => {
  it('names who did it, so an offboarding is distinguishable from an incident', () => {
    const { body } = renderNotification('user.deleted', {
      email: 'ada@example.com',
      actor: 'admin@example.com',
    });

    expect(body).toContain('admin@example.com');
  });

  it('falls back to unknown rather than blaming nobody', () => {
    expect(
      userDeletedEvent.headline({ email: 'a@x.com', actor: '' }),
    ).toContain('a@x.com');
    expect(userDeletedEvent.body({ email: 'a@x.com', actor: '' })).toContain(
      'unknown',
    );
  });
});

describe('auth.login.failed', () => {
  it('says how long the block lasts, since that is the actionable part', () => {
    expect(
      loginFailedEvent.headline({
        email: 'a@x.com',
        failures: 5,
        blockedMinutes: 1,
      }),
    ).toContain('1 minute');
  });

  it('pluralises, because "1 minutes" reads as a bug in the message', () => {
    expect(
      loginFailedEvent.headline({
        email: 'a@x.com',
        failures: 8,
        blockedMinutes: 4,
      }),
    ).toContain('4 minutes');
  });

  it('distinguishes a block from a burst that did not reach the threshold', () => {
    // Before the threshold this is a burst worth watching; at it, this is an
    // account somebody is locked out of. Collapsing them loses the difference.
    const blocked = renderNotification('auth.login.failed', {
      email: 'a@x.com',
      failures: 5,
      blockedMinutes: 1,
    });
    const watching = renderNotification('auth.login.failed', {
      email: 'a@x.com',
      failures: 2,
      blockedMinutes: 0,
    });

    expect(blocked.headline).toContain('blocked');
    expect(watching.headline).not.toContain('blocked');
    expect(watching.body).toContain('Not blocked yet');
  });

  it('carries the address even for an address that is not registered', () => {
    // The lockout counts failures against addresses nobody registered, and an
    // operator watching for attack traffic needs the address either way.
    expect(
      loginFailedEvent.body({
        email: 'nobody@example.com',
        failures: 5,
        blockedMinutes: 1,
      }),
    ).toContain('nobody@example.com');
  });
});

describe('auth.device.login', () => {
  it('names the device in the headline, because that is what is unfamiliar', () => {
    expect(
      deviceLoginEvent.headline({
        email: 'a@x.com',
        deviceName: 'iPhone',
        ip: '203.0.113.9',
        time: 'now',
      }),
    ).toContain('iPhone');
  });

  it('says "unrecognised" rather than "unrecognised device" for a blank label', () => {
    // A doubled suffix reads as a template that was filled in wrong.
    const { body } = renderNotification('auth.device.login', {
      email: 'a@x.com',
      deviceName: '  ',
      ip: '203.0.113.9',
      time: 'now',
    });

    expect(body).toContain('Device: unrecognised');
    expect(body).not.toContain('unrecognised device:');
  });

  it('carries the ip and the time, which are the other two things an operator checks', () => {
    const { body } = renderNotification('auth.device.login', {
      email: 'a@x.com',
      deviceName: 'iPhone',
      ip: '203.0.113.9',
      time: '2026-01-02T09:15:00Z',
    });

    expect(body).toContain('203.0.113.9');
    expect(body).toContain('2026-01-02T09:15:00Z');
  });
});

describe('the two-factor events', () => {
  it('says which direction it went, because "2FA" alone does not', () => {
    expect(twoFactorEnabledEvent.headline({ email: 'a@x.com' })).toContain(
      'Two-factor enabled',
    );
    expect(twoFactorDisabledEvent.headline({ email: 'a@x.com' })).toContain(
      'Two-factor disabled',
    );
  });

  it('does not use the word "disabled" in the enabled body, and vice versa', () => {
    // These two are read in the same channel seconds apart. An operator who cannot
    // tell them apart learns to open the body of both, which is the cost of a
    // headline that does not say.
    expect(twoFactorEnabledEvent.body({ email: 'a@x.com' })).not.toContain(
      'no longer',
    );
    expect(twoFactorDisabledEvent.body({ email: 'a@x.com' })).toContain(
      'no longer',
    );
  });
});

describe('maintenance.retention.anomaly', () => {
  const anomaly = {
    reason: 'the run hit its timeout',
    pending: ['user-devices'],
    failed: [],
    durationMs: 3_600_000,
  };

  it('names the targets that were never reached, which are the actionable ones', () => {
    // The reason says what happened; the pending list says what is still dirty.
    // Only the second tells an operator there is work outstanding.
    const { body } = renderNotification(
      'maintenance.retention.anomaly',
      anomaly,
    );

    expect(body).toContain('Not reached: user-devices');
  });

  it('names the failed targets separately from the pending ones', () => {
    // They are different problems: one table erroring is a bug, several unvisited
    // is a timeout. Reporting them in one list loses that.
    const { body } = renderNotification('maintenance.retention.anomaly', {
      ...anomaly,
      failed: ['refresh-tokens'],
    });

    expect(body).toContain('Failed: refresh-tokens');
  });

  it('omits both lines when neither applies, rather than printing an empty list', () => {
    const { body } = renderNotification('maintenance.retention.anomaly', {
      reason: 'x',
      pending: [],
      failed: [],
      durationMs: 1000,
    });

    expect(body).not.toContain('Not reached');
    expect(body).not.toContain('Failed');
  });

  it('renders the duration in whole seconds, because ms invites a misread', () => {
    expect(
      retentionAnomalyEvent.body({
        reason: 'x',
        pending: [],
        failed: [],
        durationMs: 3_600_000,
      }),
    ).toContain('Duration: 3600s');
  });

  it('is not per-user, so no preference lookup can silence it', () => {
    // A retention anomaly is a fact about the deployment. Making it addressable to
    // a user would let a row that no user owns be muted by nobody, which reads as a
    // silent failure rather than as an inapplicable setting.
    expect(retentionAnomalyEvent.perUser).toBe(false);
  });
});

describe('every event', () => {
  it('has a headline and a body for its own data', () => {
    // Rendered through the public entry point rather than by calling the objects, so
    // a registry entry that is not wired up fails here instead of at 3am.
    const samples: {
      [K in NotificationEventKey]: NotificationEventData[K];
    } = {
      'user.registered': { email: 'a@x.com', firstName: 'Ada' },
      'user.deleted': { email: 'a@x.com', actor: 'admin@x.com' },
      'auth.login.failed': { email: 'a@x.com', failures: 5, blockedMinutes: 1 },
      'auth.device.login': {
        email: 'a@x.com',
        deviceName: 'iPhone',
        ip: '203.0.113.9',
        time: 'now',
      },
      'auth.2fa.enabled': { email: 'a@x.com' },
      'auth.2fa.disabled': { email: 'a@x.com' },
      'maintenance.retention.anomaly': {
        reason: 'x',
        pending: [],
        failed: [],
        durationMs: 1,
      },
    };

    for (const event of NOTIFICATION_EVENT_KEYS) {
      const { headline, body } = renderNotification(event, samples[event]);

      expect(headline, event).toBeTruthy();
      expect(body, event).toBeTruthy();
    }
  });

  it('emits no markup of its own, because no two channels agree on any', () => {
    // Telegram's MarkdownV2, Slack's `mrkdwn` and Discord's markdown have no common
    // subset a sender could target: one escapes with a backslash, one with HTML
    // entities. So the registry emits plain text and each channel escapes for itself.
    // A body carrying a `<` here is not a bug — it is a user-supplied address, and
    // Slack's channel is the one that has to neutralise it.
    const { body } = renderNotification('user.registered', {
      email: 'ada@example.com',
      firstName: 'Ada',
    });

    expect(body).not.toMatch(/<[a-z]/i);
    expect(body).not.toMatch(/\*[^*]+\*/);
    expect(body).not.toMatch(/\[[^\]]+\]\(/);
  });

  it('leaves the escaping to the channel, so a value survives the round trip', () => {
    // The value is not modified here at all. Escaping it here would mean Slack and
    // Telegram both receive pre-escaped text, and one of them would escape again.
    const email = 'a_b*c`d';
    const { body } = renderNotification('user.registered', {
      email,
      firstName: 'Ada',
    });

    expect(body).toContain(email);
  });
});

describe('the escaping each channel applies', () => {
  it('escapes Slack mrkdwn with html entities, not backslashes', () => {
    // Slack's `mrkdwn` is not Markdown: `\&` renders as a literal backslash there,
    // so reusing Telegram's helper would show the operator a wall of backslashes and
    // still leave `<url|label>` clickable.
    expect(escapeSlackMarkdown('a & b <c>')).toBe('a &amp; b &lt;c&gt;');
  });

  it('escapes the ampersand first, or the entities it writes get re-escaped', () => {
    // `&` before `<`: doing it the other way turns `&lt;` into `&amp;lt;` and the
    // operator sees the entity rather than the character.
    expect(escapeSlackMarkdown('<')).toBe('&lt;');
    expect(escapeSlackMarkdown('&lt;')).toBe('&amp;lt;');
  });

  it('escapes Telegram MarkdownV2 with backslashes', () => {
    expect(escapeMarkdownV2('a_b')).toBe('a\\_b');
    expect(escapeMarkdownV2('a`b')).toBe('a\\`b');
  });

  it('neutralises a link an address could otherwise become', () => {
    // The concrete attack: a first name of `<https://evil.example|click here>`
    // rendered into a shared channel as a real link the operator is invited to
    // follow. Both syntaxes have to end up showing the characters.
    const hostile = '<https://evil.example|click here>';

    // Slack removes the `<` entirely. Telegram does not escape `<` — it is not one
    // of MarkdownV2's reserved characters — so the link is broken by escaping the
    // closing `>`, which is what a `<url|label>` needs to close. Asserting on the
    // exact output rather than on "no `<`" is what caught that difference.
    expect(escapeSlackMarkdown(hostile)).toBe(
      '&lt;https://evil.example|click here&gt;',
    );
    expect(escapeMarkdownV2(hostile)).toBe(
      '<https://evil\\.example\\|click here\\>',
    );
  });
});
