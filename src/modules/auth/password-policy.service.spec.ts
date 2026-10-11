import { beforeEach, describe, expect, it, vi } from 'vitest';

import { passwordPolicyConfig } from '../../configs/password-policy.config.js';

/**
 * The policy service is the single gate every password passes through, so the
 * assertions are about what it refuses and what it lets through — not about how it
 * reaches the answer.
 *
 * The optional estimator is varied by mocking the loader, because "the package is
 * not installed" is a supported state and a test that only ever sees it installed
 * proves nothing about a deployment that never installed it. The mock is hoisted,
 * so the mutable switch below has to be declared with `vi.hoisted` for the factory
 * to close over it.
 */

/**
 * Which fake score a given password gets.
 *
 * Keyed by literal rather than by a length rule, because a length-based stub makes
 * "asserts the score-2 boundary" and "happens to be twelve characters" the same
 * test, and only one of them is what was written. Lives inside `vi.hoisted` because
 * the factory below runs before this module's own bindings are initialised.
 */
const optional = vi.hoisted(() => ({
  installed: false,
  scores: {
    'Abcdefgh1!': 0,
    'Abcdefghij1!': 1,
    'Correct-Horse-1': 4,
  } as Record<string, number>,
}));

vi.mock('../../core/optional/optional.util.js', () => ({
  loadOptional: <T>(specifier: string): T | null =>
    optional.installed
      ? ({
          zxcvbn: (password: string) => ({
            score: optional.scores[password] ?? 4,
          }),
        }[specifier as 'zxcvbn'] as T)
      : null,
  isOptionalAvailable: (specifier: string) =>
    optional.installed && specifier === 'zxcvbn',
}));

const { PasswordPolicyService } = await import('./password-policy.service.js');

type Policy = ReturnType<typeof passwordPolicyConfig>;

const policy = (overrides: Partial<Policy> = {}): Policy => ({
  ...passwordPolicyConfig(),
  ...overrides,
});

/**
 * The service with a breach checker that is absent, which is the default profile:
 * `PASSWORD_CHECK_BREACH_LIST` is off.
 */
const build = (
  config: Policy = policy(),
  breachChecker: {
    isBreached: (password: string) => Promise<boolean>;
  } | null = null,
  history: {
    wasUsedBefore: (id: string, password: string) => Promise<boolean>;
  } | null = null,
) =>
  new PasswordPolicyService(
    { ...config } as never,
    breachChecker as never,
    history as never,
  );

/** A password meeting every default rule. */
const GOOD = 'Correct-Horse-1';

describe('the configured rules', () => {
  it('accepts a password meeting every rule', async () => {
    await expect(build().check(GOOD)).resolves.toEqual({
      ok: true,
      reasons: [],
    });
  });

  it('refuses a password below the configured minimum', async () => {
    // The whole reason the schema is a factory. A constant would freeze at 8 and
    // PASSWORD_MIN_LENGTH would be a variable nothing reads.
    await expect(
      build(policy({ minLength: 12 })).check('Abcdefgh1!'),
    ).resolves.toMatchObject({ ok: false });
  });

  it('refuses a password above the configured maximum', async () => {
    // A maximum bounds hashing work: scrypt has no 72-byte truncation, so a
    // megabyte of password is a megabyte of key derivation.
    await expect(
      build(policy({ maxLength: 8 })).check('Ab1!abcdefgh'),
    ).resolves.toMatchObject({ ok: false });
  });

  it('names the rule rather than saying the password is invalid', async () => {
    const result = await build().check('Ab1!');

    expect(result.reasons).toEqual(['Password must be at least 8 characters']);
  });

  it('lists every broken rule at once', async () => {
    // Discovering the next rule on the next attempt is how a signup form teaches
    // somebody to give up on it.
    const result = await build().check('short');

    expect(result.reasons.length).toBeGreaterThan(1);
  });

  it('exposes the policy in force, so an error can state the rule', () => {
    // The alternative is a message that says "too weak" when the actual rule is a
    // configured minimum of twelve, which the user cannot see or argue with.
    expect(build(policy({ minLength: 12 })).policy.minLength).toBe(12);
  });
});

describe('the optional strength estimator', () => {
  it('is absent by default, and a strong password still passes', async () => {
    // The default profile never installs it, so this is the path every fresh
    // clone takes. A service that failed here would reject every password in
    // development and nowhere else.
    optional.installed = false;

    const service = build();

    expect(service.hasStrengthScore).toBe(false);
    await expect(service.check(GOOD)).resolves.toMatchObject({ ok: true });
  });

  it('refuses a guessable password once it is installed', async () => {
    // The stub scores anything under twelve characters as 0, so `Abcdefgh1!` is
    // the one that gets caught while still passing every class rule.
    optional.installed = true;

    await expect(build().check('Abcdefgh1!')).resolves.toMatchObject({
      ok: false,
      reasons: [
        'This password is too easy to guess. Try several unrelated words, or a longer random string.',
      ],
    });
  });

  it('refuses a score of one, which the package calls very guessable', async () => {
    // The boundary the constant in the service states: below two is refused. A
    // score of two would pass, and asserting the one and the four either side of
    // it is what makes the constant's value a fact rather than a preference.
    optional.installed = true;

    await expect(build().check('Abcdefghij1!')).resolves.toMatchObject({
      ok: false,
    });
  });

  it('accepts a score of two, because refusing it would reject passphrases', async () => {
    // The reason the constant is 2 and not 3. A user who already types
    // `Pass1!Pass1!` everywhere should be pushed towards length, not towards a
    // different shape of the same guessable password.
    optional.scores['Abcdefghij1!'] = 2;

    await expect(build().check('Abcdefghij1!')).resolves.toMatchObject({
      ok: true,
    });
  });

  it('reports that it is installed, so a caller can name the rule', () => {
    optional.installed = true;

    expect(build().hasStrengthScore).toBe(true);
  });

  it('says how to fix it when the score is low but not zero', async () => {
    optional.installed = true;

    const result = await build().check('Abcdefgh1!');

    expect(result.reasons[0]).toContain('too easy to guess');
  });
});

describe('the breach list', () => {
  const breached = { isBreached: vi.fn(async () => true) };
  const clean = { isBreached: vi.fn(async () => false) };

  beforeEach(() => {
    optional.installed = false;
    breached.isBreached.mockClear();
    clean.isBreached.mockClear();
  });

  const withBreachCheck = { checkBreachList: true };

  it('does not call the checker while the feature is off', async () => {
    // The default. A breach check is a network call in a signup path, so it is not
    // something a boilerplate turns on for every clone.
    await expect(
      build(policy(), clean as never).check(GOOD),
    ).resolves.toMatchObject({ ok: true });
    expect(clean.isBreached).not.toHaveBeenCalled();
  });

  it('refuses a breached password once enabled', async () => {
    const service = build(policy(withBreachCheck), breached as never);

    await expect(service.check(GOOD)).resolves.toMatchObject({
      ok: false,
      reasons: [
        'This password appears in a list of passwords found in data breaches. Please choose another.',
      ],
    });
  });

  it('accepts a password the corpus does not have', async () => {
    const service = build(policy(withBreachCheck), clean as never);

    await expect(service.check(GOOD)).resolves.toMatchObject({ ok: true });
  });

  it('does not ask about a password that already failed the length rule', async () => {
    // A password that fails `minLength` cannot pass a breach check, and asking
    // spends a network call to learn nothing.
    const service = build(policy(withBreachCheck), breached as never);

    await service.check('Ab1!');

    expect(breached.isBreached).not.toHaveBeenCalled();
  });

  it('does not ask when no checker was provided, even if the flag is on', async () => {
    // The flag can be set before the provider is wired, or the module can be built
    // without one in a test. A missing dependency must not become a crash in a
    // signup.
    const service = build(policy(withBreachCheck), null);

    await expect(service.check(GOOD)).resolves.toMatchObject({ ok: true });
  });

  it('reports the breach before the strength score', async () => {
    // A breached password is the more urgent news, and the score is from an
    // optional package that may be absent — so the check that can be wrong in the
    // safe direction should not sit behind it.
    optional.installed = true;
    const service = build(policy(withBreachCheck), breached as never);

    const result = await service.check('Abcdefgh1!');

    expect(result.reasons[0]).toContain('data breaches');
    expect(result.reasons).toHaveLength(2);
  });

  it('lists the breach and the score together, so a form shows both at once', async () => {
    // Finding them one submit at a time is how somebody ends up submitting the same
    // password five times.
    optional.installed = true;
    const service = build(policy(withBreachCheck), breached as never);

    const result = await service.check('Abcdefgh1!');

    expect(result.reasons.some((r) => r.includes('breaches'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('too easy'))).toBe(true);
  });
});
