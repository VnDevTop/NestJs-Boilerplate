import { describe, expect, it } from 'vitest';

import { escapeHtml } from './layout.js';
import {
  renderTemplate,
  TEMPLATE_NAMES,
  type TemplateDataByName,
} from './template.registry.js';

/** One valid payload per template, so every template is rendered in these tests. */
const SAMPLES: { [K in keyof TemplateDataByName]: TemplateDataByName[K] } = {
  welcome: { firstName: 'Ada', appName: 'Example' },
  'verify-email': {
    verificationUrl: 'https://app.example.com/verify?token=abc',
    expiresInHours: 24,
    appName: 'Example',
  },
  'reset-password': {
    resetUrl: 'https://app.example.com/reset?token=abc',
    ip: '203.0.113.7',
    expiresInMinutes: 30,
    appName: 'Example',
  },
  'password-changed': {
    ip: '203.0.113.7',
    deviceLabel: 'Firefox on Linux',
    appName: 'Example',
  },
  'new-device-login': {
    deviceLabel: 'iPhone',
    ip: '203.0.113.9',
    time: '2026-01-02 09:15 UTC',
    appName: 'Example',
  },
  'account-locked': {
    reason: 'Too many failed sign-in attempts',
    supportUrl: 'https://example.com/support',
    appName: 'Example',
  },
  // The operator-alert template from Phase 18. Carrying hostile input here is
  // deliberate: it is the one template whose body arrives from an event rather than
  // from this repository, so it is the one that most needs the escaping asserted.
  notification: {
    headline: 'Sign-in from a new device: <b>iPhone</b>',
    body: 'Address: ada@example.com\nDevice: iPhone\nFrom: 203.0.113.9',
    appName: 'Example',
  },
};

describe('escapeHtml', () => {
  it('escapes every character that can break out of markup', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('escapes an ampersand before anything else, so an entity is not double-read', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeHtml('Firefox on Linux')).toBe('Firefox on Linux');
  });
});

describe('renderTemplate', () => {
  it('registers every template the plan lists, and no others', () => {
    // The six transactional templates from Phase 14, plus the operator-alert one
    // Phase 18 added for the notification channel. Written out rather than compared
    // against the registry, because a registry that lost an entry would otherwise
    // agree with itself.
    expect([...TEMPLATE_NAMES].sort()).toEqual([
      'account-locked',
      'new-device-login',
      'notification',
      'password-changed',
      'reset-password',
      'verify-email',
      'welcome',
    ]);
  });

  it.each(TEMPLATE_NAMES)('renders %s with both parts', (name) => {
    const rendered = renderTemplate(
      name as (typeof TEMPLATE_NAMES)[number],
      SAMPLES[name as keyof TemplateDataByName],
    );

    expect(rendered.subject).toBeTruthy();
    // The text part is what a client shows when it renders no html at all, so an
    // empty one is how a verification link goes missing.
    expect(rendered.text).toBeTruthy();
    expect(rendered.html).toContain('<html');
  });

  it.each(TEMPLATE_NAMES)('names the app in the %s footer', (name) => {
    const rendered = renderTemplate(
      name as (typeof TEMPLATE_NAMES)[number],
      SAMPLES[name as keyof TemplateDataByName],
    );

    // The footer rather than the subject: the operator-alert template's subject is
    // the event's own headline, because an operator triages a mailbox by subject
    // and "Security alert" repeated tells them nothing. Every template still carries
    // the app name, so a shared mailbox answers which deployment spoke.
    expect(rendered.text).toContain('Example');
  });

  it('puts the verification url in both parts', () => {
    const rendered = renderTemplate('verify-email', SAMPLES['verify-email']);

    expect(rendered.html).toContain(SAMPLES['verify-email'].verificationUrl);
    expect(rendered.text).toContain(SAMPLES['verify-email'].verificationUrl);
  });

  it('puts the reset url in both parts', () => {
    const rendered = renderTemplate(
      'reset-password',
      SAMPLES['reset-password'],
    );

    expect(rendered.html).toContain(SAMPLES['reset-password'].resetUrl);
    expect(rendered.text).toContain(SAMPLES['reset-password'].resetUrl);
  });

  it('names the app so a user recognises the mail', () => {
    const rendered = renderTemplate('welcome', SAMPLES.welcome);

    expect(rendered.html).toContain('Example');
    expect(rendered.text).toContain('Example');
  });

  it('greets by first name when there is one', () => {
    expect(renderTemplate('welcome', SAMPLES.welcome).text).toContain('Ada');
  });

  it('greets without a name rather than saying "Hello undefined"', () => {
    const rendered = renderTemplate('welcome', {
      ...SAMPLES.welcome,
      firstName: '',
    });

    expect(rendered.text).toContain('Hello,');
    expect(rendered.text).not.toContain('undefined');
  });

  it('escapes a first name containing markup', () => {
    // A name reaches the template from the registration form, so an unescaped
    // one is a stored injection in the mail client.
    const rendered = renderTemplate('welcome', {
      firstName: '<script>alert(1)</script>',
      appName: 'Example',
    });

    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });

  it('escapes a device label containing markup', () => {
    const rendered = renderTemplate('new-device-login', {
      ...SAMPLES['new-device-login'],
      deviceLabel: '<img src=x onerror=alert(1)>',
    });

    expect(rendered.html).not.toContain('<img');
    expect(rendered.html).toContain('&lt;img');
  });

  it('escapes a lockout reason containing markup', () => {
    const rendered = renderTemplate('account-locked', {
      ...SAMPLES['account-locked'],
      reason: '<b>admin</b>',
    });

    expect(rendered.html).not.toContain('<b>admin</b>');
  });

  it('escapes an app name in the html shell', () => {
    const rendered = renderTemplate('welcome', {
      firstName: 'Ada',
      appName: '<script>x</script>',
    });

    expect(rendered.html).not.toContain('<script>x</script>');
  });

  it('escapes a url so a quote cannot break out of the href', () => {
    const rendered = renderTemplate('verify-email', {
      ...SAMPLES['verify-email'],
      verificationUrl: 'https://x.test/v?a="onmouseover=alert(1)',
    });

    expect(rendered.html).not.toContain('"onmouseover');
    expect(rendered.html).toContain('&quot;onmouseover');
  });

  it('reports the expiry in the same units the data used', () => {
    expect(
      renderTemplate('reset-password', SAMPLES['reset-password']).text,
    ).toContain('30 minutes');
    expect(
      renderTemplate('verify-email', SAMPLES['verify-email']).text,
    ).toContain('24 hours');
  });

  it('shows the requesting ip, so a user can spot a stranger request', () => {
    const rendered = renderTemplate(
      'reset-password',
      SAMPLES['reset-password'],
    );

    expect(rendered.text).toContain('203.0.113.7');
    expect(rendered.html).toContain('203.0.113.7');
  });

  it('tells a user a reset they did not ask for is harmless', () => {
    expect(
      renderTemplate('reset-password', SAMPLES['reset-password']).text,
    ).toContain('no action is needed');
  });

  it('rejects an unknown template name', () => {
    const unknown = 'no-such-template' as 'welcome';

    expect(() => renderTemplate(unknown, SAMPLES.welcome)).toThrow(
      /Unknown mail template/,
    );
  });
});
