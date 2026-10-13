import { describe, expect, it } from 'vitest';

import { escapeHtml } from './layout.js';
import { renderTemplate, TEMPLATE_NAMES } from './template.registry.js';
import type { TemplateDataByName, TemplateName } from './template.registry.js';

/**
 * Every template, with data each one accepts and nothing else.
 *
 * `template.registry.spec.ts` covers the lookup and the mapping from name to
 * template. This covers the rendering, because the two failure modes here are
 * quiet: a template that drops its plain-text part, or one that interpolates a
 * user-controlled field into the html without escaping it. Neither throws, and
 * neither is visible until somebody reads the mail in a client that renders
 * markup.
 *
 * The escaping assertions use a payload that is hostile in every template at
 * once. If a template is edited to interpolate a new field and forgets
 * `escapeHtml`, this fails for that template rather than for the one the author
 * happened to be looking at.
 */

/** Valid in a name, a device label, an ip field and a reason sentence. */
const HOSTILE = '<script>alert("x")</script>&\'"';

const APP = 'Boilerplate';

const DATA: { [K in TemplateName]: TemplateDataByName[K] } = {
  welcome: { firstName: HOSTILE, appName: APP },
  'verify-email': {
    verificationUrl: `https://app.test/verify?token=${encodeURIComponent(HOSTILE)}`,
    expiresInHours: 24,
    appName: APP,
  },
  'reset-password': {
    resetUrl: `https://app.test/reset?token=${encodeURIComponent(HOSTILE)}`,
    ip: HOSTILE,
    expiresInMinutes: 30,
    appName: APP,
  },
  'password-changed': { ip: HOSTILE, deviceLabel: HOSTILE, appName: APP },
  'new-device-login': {
    deviceLabel: HOSTILE,
    ip: HOSTILE,
    time: HOSTILE,
    appName: APP,
  },
  'account-locked': {
    reason: HOSTILE,
    supportUrl: 'https://app.test/support',
    appName: APP,
  },
  'account-permanently-locked': {
    reason: HOSTILE,
    unlockUrl: 'https://app.test/unlock',
    expiresInHours: 48,
    failures: 20,
    appName: APP,
  },
  'account-unlocked': {
    actor: HOSTILE,
    supportUrl: 'https://app.test/support',
    appName: APP,
  },
  notification: { headline: HOSTILE, body: HOSTILE, appName: APP },
};

describe.each(TEMPLATE_NAMES)('the %s template', (name) => {
  it('renders both parts, with the app name in each', () => {
    const { subject, text, html } = renderTemplate(
      name,
      DATA[name] as TemplateDataByName[TemplateName],
    );

    expect(subject.length).toBeGreaterThan(0);
    expect(text).toContain(APP);
    expect(html).toContain(APP);
  });

  it('escapes every interpolated value in the html part', () => {
    const { html } = renderTemplate(
      name,
      DATA[name] as TemplateDataByName[TemplateName],
    );

    // The layout's own markup is the only markup in the body, so anything
    // matching a tag that is not part of the shell came from the data.
    expect(html).not.toContain('<script>');
    expect(html).not.toContain(HOSTILE);
  });

  it('is a complete html document', () => {
    const { html } = renderTemplate(
      name,
      DATA[name] as TemplateDataByName[TemplateName],
    );

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
  });

  it('tells the reader the mail is automated', () => {
    const { text, html } = renderTemplate(
      name,
      DATA[name] as TemplateDataByName[TemplateName],
    );

    expect(text).toContain('Replies are not read');
    expect(html).toContain('Replies are not read');
  });
});

describe('the templates that carry an action', () => {
  const withLink = [
    'verify-email',
    'reset-password',
    'account-locked',
    'account-permanently-locked',
    'account-unlocked',
  ] as const satisfies readonly TemplateName[];

  it.each(withLink)('offers %s a link in both parts', (name) => {
    const { text, html } = renderTemplate(
      name,
      DATA[name] as (typeof DATA)[typeof name],
    );

    // A mail client that shows neither formatting nor images still has to show
    // the link, which is why the text part is not a stripped copy of the html.
    expect(text).toContain('http');
    expect(html).toContain('<a href=');
  });
});

describe('the templates that do not carry an action', () => {
  it('gives the welcome mail no link to follow', () => {
    const { html } = renderTemplate('welcome', DATA.welcome);

    expect(html).not.toContain('<a href=');
  });

  it('turns the notification body into a list rather than one paragraph', () => {
    const { html } = renderTemplate('notification', {
      headline: 'Repeated failed sign-ins',
      body: 'first line\nsecond line',
      appName: APP,
    });

    // One row per non-empty body line. Counting `<tr>` would also count the
    // layout's own two rows, and the assertion would pass with one body line.
    expect(html.match(/padding:1px 10px 1px 0/g)).toHaveLength(2);
  });

  it('falls back to a count-free sentence when the failure count is unknown', () => {
    // The count is only known while redis still remembers it. Guessing a number
    // would put a false number in an email about somebody's account.
    const { text } = renderTemplate('account-permanently-locked', {
      ...DATA['account-permanently-locked'],
      failures: null,
    });

    expect(text).toContain('too many failed sign-in attempts');
    expect(text).not.toContain('null');
  });
});

describe('escapeHtml', () => {
  it('escapes the five characters that can change markup', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeHtml('Ada Lovelace, London')).toBe('Ada Lovelace, London');
  });
});
