/**
 * What never reaches a log line or an audit row.
 *
 * **By name, not by value.** There is no reliable way to tell a secret from an
 * ordinary string: a JWT looks like a hash, a hash looks like a nonce. Naming the
 * fields is the only rule that can be applied to a payload nobody has seen yet,
 * and every application has the same names for the same things.
 *
 * Matching is exact and case-insensitive, so `authorization` and `Authorization`
 * are both caught. Substring matching is deliberately not used: `tokenCount` and
 * `tokenisedAt` are not secrets, and a list that redacts them makes the output
 * harder to read and trains people to ignore the redaction.
 */
export const REDACTED_KEYS: ReadonlySet<string> = new Set(
  [
    // Credentials.
    'password',
    'newPassword',
    'currentPassword',
    'confirmPassword',
    'token',
    'tokenHash',
    'accessToken',
    'refreshToken',
    'idToken',
    'challengeToken',
    'resetToken',
    'verificationToken',
    'unlockToken',
    // The refresh token's unique id. Not a credential on its own, but the one
    // half of `token:revoked:<jti>` — the Redis key that decides whether a
    // session is dead. Anyone holding it can confirm which sessions exist and
    // when they were cut, which is reconnaissance rather than access. The row
    // it lives on is `{ jti: ... }`, so key-based redaction is what catches it.
    'jti',
    // Two-factor.
    'secret',
    'twoFactorSecret',
    'secretCiphertext',
    'secretIv',
    'secretAuthTag',
    'otp',
    'code',
    'totp',
    'recoveryCodes',
    // Transport and session.
    'authorization',
    'cookie',
    'setCookie',
    'set-cookie',
    'sessionSecret',
    'jwtSecret',
    'apiKey',
    'clientSecret',
    'privateKey',
    'signature',
  ].map((key) => key.toLowerCase()),
);

/** What a redacted value is replaced with. */
export const REDACTED = '[redacted]';

/**
 * How deep to walk before giving up.
 *
 * A log payload can be a request body, and a body can nest ten thousand levels
 * deep. Unbounded recursion there is a stack overflow *inside the error handler*,
 * which is the worst place in a process to have one.
 */
const MAX_DEPTH = 12;

/**
 * Replaces the value of any sensitive key, at any depth.
 *
 * Replaced rather than removed: a key that disappears makes "the password changed"
 * indistinguishable from "this payload never had a password". A visible
 * `[redacted]` answers the question without answering it wrongly.
 *
 * **Circular references are handled**, because a logger that throws on a cyclic
 * object breaks the request it was describing. `JSON.stringify` throws on one, and
 * this value goes straight into a `JSON.stringify` in `AppLogger`.
 */
export function redactValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (depth > MAX_DEPTH) {
    return '[too deep]';
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    // The same guard set, threaded through. A fresh one per array would make
    // `a.list[0] === a` walk forever, which is the case a redaction pass most
    // needs to survive: it is called on request bodies.
    return value.map((entry) => redactValue(entry, depth + 1, seen));
  }

  return redactRecord(value as Record<string, unknown>, depth, seen);
}

/** The object case of {@link redactValue}, with the cycle guard. */
function redactRecord(
  source: Record<string, unknown>,
  depth: number,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  // A shared object is not a cycle — the same row logged twice is fine — but
  // walking it twice is wasteful and the guard has to survive it anyway.
  if (seen.has(source)) {
    return '[circular]';
  }

  seen.add(source);

  const out: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(source)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase())
      ? REDACTED
      : redactValue(entry, depth + 1, seen);
  }

  return out;
}

/**
 * Patterns that catch a secret embedded in a *sentence*.
 *
 * **The key-based pass cannot see this.** Most log lines in this application are
 * strings — `Failed to reset for ${email} using ${token}` compiles to one — and a
 * token inside a message has no key above it. These are the cases that reach a log
 * shipper whole.
 *
 * Deliberately narrow. Each pattern has to match a credential *and* something
 * that identifies it as one, so the chance of a false positive is close to zero:
 * redacting ordinary text teaches people to ignore the redaction, which is worse
 * than the leak it prevents.
 */
const TEXT_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  // `Authorization: Bearer eyJhb...` — the value is the whole token.
  {
    pattern: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: `$1 ${REDACTED}`,
  },
  // `?token=abc&other=1` — a reset or verification link in a message. The
  // parameter name is kept so the line still says which link it was.
  {
    pattern:
      /([?&](?:token|access_token|refresh_token|otp|code|secret|signature|password|key)=)[^&\s"'<>]*/gi,
    replacement: `$1${REDACTED}`,
  },
  // `token: abc` / `"password" : "abc"` inside a message that is already a string.
  //
  // `authorization` and the cookies are absent on purpose: the two patterns above
  // already handle them, and running this one afterwards over their output
  // produced `Authorization: [redacted] [redacted]` — a redacted line that no
  // longer says what it was, which is the cost of a pattern that overlaps.
  {
    // `(?!\[redacted\])` is what stops this pattern matching a value an earlier
    // one has already replaced. Without it `?token=[redacted]` gets matched again
    // and comes out `?token=[redacted]]` — a visible bug, and the kind that makes
    // somebody decide the redaction is broken and turn it off.
    pattern:
      /\b(token|password|secret|otp|apiKey|api_key|clientSecret|client_secret)\b(\s*[:=]\s*)(?!\[redacted\])("[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi,
    replacement: `$1$2${REDACTED}`,
  },
  // `Cookie: session=…` and `Set-Cookie:` — a session id in a line about a
  // response, which is where it usually leaks from.
  {
    pattern: /\b(set-cookie|cookie)(\s*:\s*)[^\n]+/gi,
    replacement: `$1$2${REDACTED}`,
  },
  // Webhook and bot URLs, where the credential is the path rather than a
  // parameter, so nothing above can see it:
  //
  //   https://hooks.slack.com/services/T…/B…/…
  //   https://discord.com/api/webhooks/…/…
  //   https://api.telegram.org/bot…/…
  //
  // These are the three shapes the notification channels post to, and each one is
  // a complete credential that anybody can post to. They arrive in exception
  // messages — a transport that echoes the url it was given — and those messages
  // are caught into an `error` field, which is a database column. The patterns
  // are pinned to those hosts so an ordinary url in a log line keeps its path,
  // which is usually the part the reader wanted.
  {
    pattern: /\b(https:\/\/hooks\.slack\.com\/services\/)[^\s"'<>]+/gi,
    replacement: `$1${REDACTED}`,
  },
  {
    pattern:
      /\b(https:\/\/(?:[a-z0-9-]+\.)*discord(?:app)?\.com\/api\/webhooks\/)[^\s"'<>]+/gi,
    replacement: `$1${REDACTED}`,
  },
  {
    pattern: /\b(https:\/\/api\.telegram\.org\/bot)[^\s"'<>]+/gi,
    replacement: `$1${REDACTED}`,
  },
];

/**
 * Scrubs a secret out of a message that is already a string.
 *
 * Applied on top of {@link redactValue} rather than instead of it, because they
 * catch different things: this one sees a credential with no key above it, and the
 * other sees a key whose value is structured. Neither subsumes the other.
 *
 * Non-strings pass through untouched. A caller that has an object calls
 * `redactValue` first, and re-applying these patterns to its rendered form would
 * mangle a field that merely contains the word "code".
 */
export function redactText(text: string): string {
  return TEXT_PATTERNS.reduce(
    (current, { pattern, replacement }) =>
      current.replace(pattern, replacement),
    text,
  );
}

/**
 * The whole surface, for a log entry's `message`.
 *
 * One call rather than two at every call site, because the order matters — a
 * string needs the text pass, a structure needs the key pass — and an order a
 * caller has to remember is an order a caller gets wrong.
 */
export function redactForLog(message: unknown): unknown {
  return typeof message === 'string'
    ? redactText(message)
    : redactValue(message);
}
