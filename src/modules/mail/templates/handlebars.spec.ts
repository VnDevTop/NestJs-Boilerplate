import { describe, expect, it } from 'vitest';

import { assertSafeToRender, compilePart, renderPart } from './handlebars.js';

/**
 * The escaping boundary a stored template is held to.
 *
 * Everything here is about one fact: a stored template is **untrusted input**, even
 * though only an administrator writes it. The reason is not that administrators are
 * hostile — it is that a template renders into somebody's mail client, the values it
 * interpolates are user-controlled, and `{{{ }}}` is handlebars' documented way of
 * turning off escaping. An operator who pastes a snippet from a mail-design tool
 * arrives with triple-braces already in it, which makes this a plausible accident
 * rather than a contrived attack.
 *
 * The `.hbs` files in the repository are not held to this. They went through review,
 * which is the property the Phase 14 plain functions had and the reason the rule is
 * applied to one and not the other.
 */
describe('a stored template', () => {
  it('is refused for a triple-brace expression', () => {
    expect(() =>
      assertSafeToRender('<p>Hello {{{firstName}}}</p>', 'welcome html'),
    ).toThrow(/triple-brace/i);
  });

  it.each([
    ['spaced out', '{{ {firstName} }}'],
    ['split across lines', '{{{\nfirstName\n}}}'],
    ['with a name inside', '{{{user.name}}}'],
    ['with a helper inside', '{{{helper arg}}}'],
  ])('is refused when the triple-brace is %s', (_label, source) => {
    // Checked in every spacing handlebars accepts, because a check for the literal
    // `{{{` would reject the common spelling and pass the other three — and the
    // other three are the ones an attacker or a careless paste would use.
    expect(() => assertSafeToRender(source, 'welcome html')).toThrow(
      /triple-brace/i,
    );
  });

  it('is refused in the subject and the text part too, not only the html', () => {
    // The rule is applied to all three parts in `save`, so a template that puts the
    // raw form in a subject would otherwise reach a mailbox subject line.
    expect(() =>
      assertSafeToRender('Hello {{{firstName}}}', 'welcome subject'),
    ).toThrow(/triple-brace/i);
    expect(() =>
      assertSafeToRender('Hello {{{firstName}}}', 'welcome text'),
    ).toThrow(/triple-brace/i);
  });

  it('is allowed for the double-brace form, and escapes what it interpolates', () => {
    expect(() =>
      assertSafeToRender('<p>Hello {{firstName}}</p>', 'welcome html'),
    ).not.toThrow();

    const rendered = renderPart(compilePart('{{firstName}}', 'test'), {
      firstName: '<script>alert("x")</script>',
    });

    // The whole point: the double-brace form survives validation and still escapes, so
    // the rule is not "no interpolation" but "no unescaped interpolation".
    expect(rendered).not.toContain('<script>');
    expect(rendered).toContain('&lt;script&gt;');
  });

  it('is refused for a helper nobody registered', () => {
    // `knownHelpersOnly` is a whitelist over *helpers*, so it is what stops a helper
    // registered elsewhere in the process from becoming callable from a stored
    // template. Verified against the installed handlebars rather than assumed: a name
    // in the whitelist compiles, and one outside it does not.
    expect(() =>
      compilePart('{{actionLink url "Verify"}}', 'welcome html'),
    ).not.toThrow();

    // `strict: true` is what covers the name that is not a helper at all — a typo
    // in a variable. Without it, `{{firstname}}` renders as an empty string and the
    // only symptom is a hole in somebody's welcome email.
    expect(() =>
      renderPart(compilePart('{{firstname}}', 'welcome html'), {
        firstName: 'Ada',
      }),
    ).toThrow(/not defined/i);
  });

  it('refuses to render a field that was not supplied', () => {
    // `strict` is what turns a typo in a variable name into an error rather than a
    // hole in the email. A stored template that interpolates `firstname` instead of
    // `firstName` is exactly the mistake that otherwise reaches a user's inbox.
    const compiled = compilePart('{{firstName}}', 'welcome html');

    expect(() => renderPart(compiled, {})).toThrow(/not defined/i);
  });

  it('cannot reach the prototype chain', () => {
    const rendered = renderPart(
      compilePart('[{{constructor}}][{{__proto__}}]', 'test'),
      { firstName: 'Ada' },
    );

    // Handlebars blocks prototype access by default and this pins that default. A
    // template that could read `{{constructor.constructor}}` would be a template that
    // could reach `process` in some version of some release.
    expect(rendered).toBe('[][]');
  });
});

describe('the compiled helpers', () => {
  it('renders an action link rather than a bare url', () => {
    const rendered = renderPart(
      compilePart('{{actionLink url "Verify"}}', 'test'),
      { url: 'https://app.test/verify?token=a&b=1' },
    );

    // The helper escapes the url on the way in, so a `{{verificationUrl}}` can be
    // handed straight to it without a second escape that would double-encode the
    // `&` and break the query string. Asserted on the escaped form because that is
    // what the href genuinely contains.
    expect(rendered).toContain(
      'href="https://app.test/verify?token=a&amp;b=1"',
    );
    expect(rendered).toContain('Or paste this into your browser');
  });

  it('leaves a url usable, escaping only what can break out of the attribute', () => {
    // The assertion that caught a real bug. `Handlebars.escapeExpression` encodes
    // `=` as `&#x3D;`, which is correct for html and catastrophic for a url: the
    // entity reaches the mail client verbatim, so `?token=a&b=1` becomes
    // `?token&#x3D;a&amp;b&#x3D;1` and the token no longer matches what the server
    // issued. Every verification and reset link in the application would have been
    // dead, and the only symptom would have been a support ticket saying the link
    // does not work.
    const rendered = renderPart(
      compilePart('{{actionLink url "Verify"}}', 'test'),
      { url: 'https://app.test/verify?token=abc123&next=%2Fhome' },
    );

    expect(rendered).toContain(
      'href="https://app.test/verify?token=abc123&amp;next=%2Fhome"',
    );
    // The `=` is the character that must survive. Asserted explicitly so the fix
    // cannot be undone by someone reaching for the general escaper again.
    expect(rendered).not.toContain('&#x3D;');
  });

  it('escapes a label passed to the action link', () => {
    const rendered = renderPart(
      compilePart('{{actionLink url label}}', 'test'),
      { url: 'https://app.test/', label: '<script>alert("x")</script>' },
    );

    expect(rendered).not.toContain('<script>');
  });

  it('tells a missing count from a count of zero', () => {
    const template = compilePart(
      '{{#if (isNull failures)}}too many{{else}}{{failures}}{{/if}}',
      'test',
    );

    // The reason `isNull` exists at all: `{{#if failures}}` treats 0 as absent, so
    // the template would say "too many" about a lock that took no attempts, and
    // claim a count it does not have in the other direction.
    expect(renderPart(template, { failures: null })).toBe('too many');
    expect(renderPart(template, { failures: 0 })).toBe('0');
    expect(renderPart(template, { failures: 7 })).toBe('7');
  });

  it('splits an alert body into one row per line, dropping the blank ones', () => {
    const rendered = renderPart(
      compilePart('{{#each (bodyLines body)}}[{{this}}]{{/each}}', 'test'),
      { body: 'first\n\nsecond\n' },
    );

    // A trailing newline is not a message, and a blank row would render as a bullet
    // with nothing beside it.
    expect(rendered).toBe('[first][second]');
  });
});
