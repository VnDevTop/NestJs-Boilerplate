import { describe, expect, it } from 'vitest';

import { passwordPolicyConfig } from './password-policy.config.js';
import {
  buildPasswordSchema,
  checkPasswordFormat,
} from './password-policy.schema.js';

/**
 * The policy is the thing a deployment sets and the thing a user argues with, so
 * the assertions are about the message as much as the verdict: "Password is
 * invalid" on a signup form is why people end up choosing `Password1!`.
 */

const policy = (
  overrides: Partial<ReturnType<typeof passwordPolicyConfig>> = {},
) => ({
  ...passwordPolicyConfig(),
  ...overrides,
});

describe('buildPasswordSchema', () => {
  it('accepts a password meeting every rule', () => {
    const result = checkPasswordFormat('Correct-Horse-1', policy());

    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('reads the configured minimum rather than a hard-coded one', () => {
    // The whole point of the factory. A constant here would freeze at 8 and the
    // deployment's PASSWORD_MIN_LENGTH would be a variable nothing reads.
    const strict = checkPasswordFormat('Abcdefgh1!', policy({ minLength: 12 }));
    const lenient = checkPasswordFormat('Abcdefgh1!', policy({ minLength: 8 }));

    expect(strict.ok).toBe(false);
    expect(lenient.ok).toBe(true);
  });

  it('reads the configured maximum', () => {
    // A maximum is a bound on hashing work: scrypt has no 72-byte truncation, so a
    // megabyte of password is a megabyte of key derivation.
    expect(
      checkPasswordFormat('Ab1!abcdefgh', policy({ maxLength: 8 })).ok,
    ).toBe(false);
  });

  it('names the length rule rather than saying the password is invalid', () => {
    const result = checkPasswordFormat('Ab1!', policy());

    expect(result.reasons).toEqual(['Password must be at least 8 characters']);
  });

  it('names which character class is missing', () => {
    const result = checkPasswordFormat('abcdefghij', policy());

    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'Password must contain an uppercase letter',
        'Password must contain a number',
        'Password must contain a symbol',
      ]),
    );
  });

  it('lists every broken rule at once, so a form can show them together', () => {
    // Discovering the next rule on the next attempt is how a signup form teaches
    // somebody to give up on it.
    const result = checkPasswordFormat('short', policy());

    expect(result.reasons.length).toBeGreaterThan(1);
  });

  it('does not repeat one message when two rules fail the same way', () => {
    // An empty password trips both the minimum and every class rule; a form that
    // says the same thing four times reads as four separate problems.
    const result = checkPasswordFormat('', policy());

    expect(new Set(result.reasons).size).toBe(result.reasons.length);
  });

  describe('the class rules are individually switchable', () => {
    it('drops the symbol rule when it is off', () => {
      const relaxed = policy({ requireSymbol: false });

      expect(checkPasswordFormat('Abcdefg1', relaxed).ok).toBe(true);
    });

    it('drops the number rule when it is off', () => {
      const relaxed = policy({ requireNumber: false });

      expect(checkPasswordFormat('Abcdefgh!', relaxed).ok).toBe(true);
    });

    it('drops the uppercase rule when it is off', () => {
      const relaxed = policy({ requireUppercase: false });

      expect(checkPasswordFormat('abcdefg1!', relaxed).ok).toBe(true);
    });

    it('drops the lowercase rule when it is off', () => {
      const relaxed = policy({ requireLowercase: false });

      expect(checkPasswordFormat('ABCDEFG1!', relaxed).ok).toBe(true);
    });

    it('accepts a passphrase with every class rule off and length carrying it', () => {
      // The composition gauntlet is what pushes people to `Password1!`. With the
      // classes off, a long passphrase is the strongest thing available.
      const passphrase = policy({
        requireLowercase: false,
        requireUppercase: false,
        requireNumber: false,
        requireSymbol: false,
        minLength: 20,
      });

      expect(
        checkPasswordFormat('correct horse battery staple', passphrase).ok,
      ).toBe(true);
    });

    it('still applies length with every class rule off', () => {
      const passphrase = policy({
        requireLowercase: false,
        requireUppercase: false,
        requireNumber: false,
        requireSymbol: false,
        minLength: 20,
      });

      expect(checkPasswordFormat('short', passphrase).ok).toBe(false);
    });
  });

  it('returns a schema, so a caller can embed the rule in a larger one', () => {
    const schema = buildPasswordSchema(policy());

    expect(schema.safeParse('Correct-Horse-1').success).toBe(true);
    expect(schema.safeParse('nope').success).toBe(false);
  });

  it('treats a non-string as a failure rather than throwing', () => {
    // The value arrives from a request body, and a schema that throws on the wrong
    // type turns a validation error into a 500.
    const schema = buildPasswordSchema(policy());

    expect(schema.safeParse(undefined as never).success).toBe(false);
    expect(schema.safeParse(42 as never).success).toBe(false);
  });
});
