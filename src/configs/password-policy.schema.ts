import { z } from 'zod';

import type { PasswordPolicyConfig } from './password-policy.config.js';

/**
 * The password rule, built from configuration.
 *
 * **A factory rather than a constant.** The policy is deployment state, read from
 * the environment, and a `z.object({ min: z.string().min(8) })` at module scope
 * would freeze the values at import time — before `ConfigModule` has read
 * anything, and in a test before it has been able to set the environment at all.
 *
 * **zod, not class-validator, despite what the rest of the DTOs use.** The
 * validators on a DTO are decorators, so they are evaluated when the class is
 * defined and have no access to configuration; expressing this policy that way
 * means either a hard-coded number per DTO — which is the thing this replaces — or
 * a custom decorator that reads a global. `safeParse` here also produces one
 * message listing every rule that failed, so a user correcting a signup form is
 * told everything at once instead of discovering the next rule on the next
 * attempt.
 *
 * **No composition gauntlet by default.** All four classes at once rejects
 * `correct-horse-battery-staple`, which is stronger than the passwords a
 * composition rule pushes people toward. Each class is separately switchable
 * because a deployment may want one and not the others, and the defaults are the
 * ones this boilerplate considers right rather than the ones a linter ships with.
 */
export function buildPasswordSchema(
  config: PasswordPolicyConfig,
): z.ZodType<string, string> {
  let schema = z
    .string()
    .min(
      config.minLength,
      `Password must be at least ${config.minLength} characters`,
    );

  schema = schema.max(
    config.maxLength,
    `Password must be at most ${config.maxLength} characters`,
  );

  // Built as one message per class rather than a composed `.regex`, so the failure
  // says which rule was broken. "Password is invalid" on a signup form is the
  // reason people pick `Password1!`.
  const rules: [boolean, RegExp, string][] = [
    [
      config.requireLowercase,
      /[a-z]/,
      'Password must contain a lowercase letter',
    ],
    [
      config.requireUppercase,
      /[A-Z]/,
      'Password must contain an uppercase letter',
    ],
    [config.requireNumber, /[0-9]/, 'Password must contain a number'],
    [config.requireSymbol, /[^A-Za-z0-9]/, 'Password must contain a symbol'],
  ];

  for (const [required, pattern, message] of rules) {
    if (required) {
      schema = schema.refine((value) => pattern.test(value), { message });
    }
  }

  return schema;
}

/**
 * Why a password was refused, in the words a form can show.
 *
 * Returned rather than thrown inside the schema because the breach check and the
 * history check are not schema rules — they need the network and the database —
 * and this is the one shape all three answers take.
 */
export type PasswordRejection = string;

export interface PasswordCheckResult {
  ok: boolean;
  /** Every reason it was refused, so the caller can show all of them at once. */
  reasons: PasswordRejection[];
}

/**
 * Runs the pure part of the policy: length and character classes.
 *
 * Separate from the breach and history checks because those are asynchronous and
 * this one is not, and because the ordering matters — refusing `short` before
 * making a network call is both faster and kinder to the API.
 */
export function checkPasswordFormat(
  password: string,
  config: PasswordPolicyConfig,
): PasswordCheckResult {
  const parsed = buildPasswordSchema(config).safeParse(password);

  if (parsed.success) {
    return { ok: true, reasons: [] };
  }

  return {
    ok: false,
    // Deduplicated: `min` and `max` both fire on an empty string, and a form that
    // says the same thing twice reads as two separate problems.
    reasons: [...new Set(parsed.error.issues.map((issue) => issue.message))],
  };
}
