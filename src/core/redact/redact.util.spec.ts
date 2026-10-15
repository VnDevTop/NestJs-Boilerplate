import { describe, expect, it } from 'vitest';

import {
  REDACTED,
  REDACTED_KEYS,
  redactForLog,
  redactText,
  redactValue,
} from './redact.util.js';

/**
 * Two failure modes, and both of them are quiet.
 *
 * **The list that is too short.** A password in a log line goes to a shipper, from
 * a shipper to an index, from an index to whoever runs the query, and nothing about
 * that path looks like a leak. It is a year of logs and one credential in it.
 *
 * **The list that is too long.** Redacting `tokenCount` and `code` makes the
 * output unreadable and trains people to ignore the redaction entirely, which is
 * worse than the leak it was meant to prevent. So the exact cases below are as
 * much a specification as the misses.
 */
describe('a key that names a credential', () => {
  it.each([
    'password',
    'token',
    'accessToken',
    'refreshToken',
    'resetToken',
    'verificationToken',
    'secret',
    'twoFactorSecret',
    'otp',
    'recoveryCodes',
    'authorization',
    'cookie',
    'apiKey',
    'signature',
    'jti',
  ])('has %s in the list', (key) => {
    expect(REDACTED_KEYS.has(key.toLowerCase())).toBe(true);
  });

  it('carries the refresh token id, which is the half of the revocation key', () => {
    // `token:revoked:<jti>` is how a session is killed, so a jti is not an access
    // credential — but it is the piece somebody with a log can use to enumerate
    // which sessions exist and which were cut. The row that carries it is
    // `{ jti: ... }`, so this is the name redaction matches on.
    const redacted = redactValue({ jti: '0f8a-4c21-9b', userId: 'u1' });

    expect(redacted).toEqual({ jti: REDACTED, userId: 'u1' });
  });

  it('is matched whatever the casing, because a header arrives however it arrives', () => {
    expect(REDACTED_KEYS.has('authorization')).toBe(true);
    expect(REDACTED_KEYS.has('Authorization'.toLowerCase())).toBe(true);
  });
});

describe('replacing by key', () => {
  it('replaces the value and keeps the key', () => {
    // A key that disappears makes "the password changed" indistinguishable from
    // "this payload never had a password". A visible marker answers the question
    // without answering it wrongly.
    expect(redactValue({ password: 'hunter2', email: 'a@x.com' })).toEqual({
      password: REDACTED,
      email: 'a@x.com',
    });
  });

  it('replaces at any depth', () => {
    // A payload is usually a request body, and a body nests.
    expect(
      redactValue({ user: { profile: { secrets: { token: 'abc' } } } }),
    ).toEqual({ user: { profile: { secrets: { token: REDACTED } } } });
  });

  it('replaces inside arrays, which is where a list of session tokens lives', () => {
    const redacted = redactValue({ sessions: [{ refreshToken: 'r1' }] }) as {
      sessions: { refreshToken: string }[];
    };

    expect(redacted.sessions[0]?.refreshToken).toBe(REDACTED);
  });

  it('leaves a field that merely mentions one, because it is not one', () => {
    // `tokenCount` and `passwordChangedAt` are ordinary column names. Matching on
    // substrings would redact both, which makes the output unreadable and trains
    // people to ignore the redaction.
    const redacted = redactValue({
      tokenCount: 4,
      passwordChangedAt: '2026-01-01',
      secretariat: 'no',
    }) as Record<string, unknown>;

    expect(redacted).toEqual({
      tokenCount: 4,
      passwordChangedAt: '2026-01-01',
      secretariat: 'no',
    });
  });

  it('redacts `code` even though it is usually a country, because here it is a 2FA code', () => {
    // The over-redaction trade made explicitly, because it is the one place the
    // list is deliberately too long. `TwoFactorCodeDto.code` is the field a six
    // digit one-time password arrives in, and a missed redaction there is a second
    // factor in a log shipper. `code: 'EN'` is redacted as a result, which is an
    // annoyance rather than a leak.
    expect(redactValue({ code: '492913' })).toEqual({ code: REDACTED });
  });

  it('passes null and undefined through', () => {
    expect(redactValue(null)).toBeNull();
    expect(redactValue({ a: undefined })).toEqual({ a: undefined });
  });

  it('stops at a fixed depth rather than recursing into a hostile body', () => {
    // A body can nest ten thousand levels deep, and unbounded recursion inside an
    // error handler is a stack overflow at the worst possible moment.
    let deep: Record<string, unknown> = { password: 'bottom' };

    for (let level = 0; level < 50; level += 1) {
      deep = { nested: deep };
    }

    expect(JSON.stringify(redactValue(deep))).toContain('[too deep]');
  });

  it('survives a self-referencing object, which is the case a logger most needs', () => {
    // This value goes straight into a `JSON.stringify` in `AppLogger`. A cyclic
    // object there throws, and a logger that throws breaks the request it was
    // describing.
    const cyclic: Record<string, unknown> = { name: 'a' };

    cyclic['self'] = cyclic;

    expect(() => redactValue(cyclic)).not.toThrow();
    expect(JSON.stringify(redactValue(cyclic))).toContain('[circular]');
  });

  it('survives a cycle that goes through an array', () => {
    // The guard set is threaded through the array branch too. A fresh one per
    // array would make `a.list[0] === a` walk forever.
    const cyclic: Record<string, unknown> = { name: 'a' };

    cyclic['list'] = [cyclic];

    expect(() => redactValue(cyclic)).not.toThrow();
  });
});

describe('scrubbing a sentence', () => {
  it('is a separate pass, because a token in a message has no key above it', () => {
    // Most log lines here are strings. `Failed to reset for ${email} using
    // ${token}` compiles to one, and the key-based pass cannot see it.
    expect(redactText('Failed to reset for a@x.com using abc123def456')).toBe(
      'Failed to reset for a@x.com using abc123def456',
    );
    expect(redactText('reset link sent: ?token=abc123def456&x=1')).toBe(
      `reset link sent: ?token=${REDACTED}&x=1`,
    );
  });

  it('redacts a bearer token, which is the most common leak in a request log', () => {
    expect(redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  it('keeps the parameter name, so the line still says which link it was', () => {
    // A line reading `?link=[redacted]` tells an operator nothing; `?token=
    // [redacted]` tells them it was a reset link rather than a verification one.
    expect(redactText('/verify-email?token=abc123&expires=99')).toBe(
      `/verify-email?token=${REDACTED}&expires=99`,
    );
  });

  it('redacts a bare `key: value` assignment in a message', () => {
    expect(redactText('smtp rejected, apiKey: AKIA123456, retrying')).toBe(
      `smtp rejected, apiKey: ${REDACTED}, retrying`,
    );
  });

  it('redacts a cookie, which leaks from response logging more than anything', () => {
    expect(redactText('Set-Cookie: session=abc; HttpOnly')).toBe(
      `Set-Cookie: ${REDACTED}`,
    );
  });

  it.each([
    [
      'a slack webhook',
      'post failed for https://hooks.slack.com/services/T1/B1/x',
    ],
    [
      'a discord webhook',
      'post failed for https://discord.com/api/webhooks/1/y',
    ],
    [
      'a telegram bot',
      'post failed for https://api.telegram.org/bot1:1/sendMessage',
    ],
  ])('redacts %s, where the credential is the path', (_label, input) => {
    // None of the patterns above can see these: there is no `key=value`, no
    // header and no bearer token, just a url that is itself the secret. They reach
    // logs through exception messages from the transports that post to them.
    const scrubbed = redactText(input);

    expect(scrubbed).not.toBe(input);
    expect(scrubbed).toContain(REDACTED);
  });

  it('keeps the path of an ordinary url, which is what the reader wanted', () => {
    // The reason those three patterns are pinned to their hosts. Redacting every
    // url path would make this list fire on ordinary prose, and a redactor that
    // cries wolf is one people switch off.
    expect(
      redactText('migrated 12 rows at /api/v1/users/me/export?format=csv'),
    ).toBe('migrated 12 rows at /api/v1/users/me/export?format=csv');
  });

  it('leaves ordinary text alone, because a redaction that fires on prose is a redaction nobody reads', () => {
    const line = 'Retention finished in 4s, 42 rows deleted from users';

    expect(redactText(line)).toBe(line);
  });
});

describe('choosing between the two', () => {
  it('picks the text pass for a string', () => {
    expect(redactForLog('?token=abc123def456')).toBe(`?token=${REDACTED}`);
  });

  it('picks the key pass for a structure', () => {
    expect(redactForLog({ password: 'hunter2' })).toEqual({
      password: REDACTED,
    });
  });

  it('does not run the text pass over a rendered structure', () => {
    // A field that merely contains the word `code` must not have its value
    // mangled, and rendering the object first would make that impossible to avoid.
    expect(redactForLog({ countryCode: 'EN', description: 'a code' })).toEqual({
      countryCode: 'EN',
      description: 'a code',
    });
  });
});
