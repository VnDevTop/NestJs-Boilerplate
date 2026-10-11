import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { loadOptional } from '../../core/optional/index.js';
import {
  passwordPolicyConfig,
  type PasswordPolicyConfig,
} from '../../configs/password-policy.config.js';
import {
  checkPasswordFormat,
  type PasswordCheckResult,
} from '../../configs/password-policy.schema.js';

/**
 * The shape `zxcvbn` exposes, narrowed to what is used here.
 *
 * Declared rather than imported, because the package is optional and a type import
 * of a package that is not installed fails the build — the exact failure
 * `loadOptional` exists to avoid.
 */
interface ZxcvbnResult {
  score: number;
}

type Zxcvbn = (password: string) => ZxcvbnResult;

export const ZXCVBN_SPECIFIER = 'zxcvbn';

/**
 * Below this the password is refused outright.
 *
 * 2 is the first score a human-chosen password reaches, and it means "somewhat
 * guessable". Refusing 0 and 1 catches the obvious ones; refusing 2 as well would
 * start rejecting passphrases a user has probably already used everywhere, which
 * is exactly the advice to stop following.
 */
export const MINIMUM_ACCEPTABLE_SCORE = 2;

/**
 * One place that decides whether a password is acceptable.
 *
 * Every path that sets a password goes through here — registration, a reset, and
 * an administrator creating an account — so a rule added here applies to all of
 * them at once. That is the point of the class: a policy enforced at three call
 * sites is a policy enforced until one of them is edited.
 *
 * **The optional strength estimator is off unless installed.** `zxcvbn` is about a
 * megabyte of dictionaries, which is a real cost for a boilerplate every clone
 * pays, so it is not a dependency. `loadOptional` resolves it once at
 * construction, and a deployment that wants the score installs it and changes
 * nothing. See `docs/optional-integrations.md`.
 */
@Injectable()
export class PasswordPolicyService {
  private readonly logger = new Logger(PasswordPolicyService.name);

  /**
   * Resolved once at construction rather than per call, so a signup does not hit
   * the module resolver every time.
   */
  private readonly zxcvbn: Zxcvbn | null;

  constructor(
    @Inject(passwordPolicyConfig.KEY)
    private readonly config: ConfigType<typeof passwordPolicyConfig>,
  ) {
    this.zxcvbn = loadOptional<Zxcvbn>(ZXCVBN_SPECIFIER);

    if (this.zxcvbn === null) {
      this.logger.log(
        'zxcvbn is not installed, so passwords are checked against the ' +
          'configured rules only. Install it with: npm install zxcvbn',
      );
    }
  }

  /** True when the optional strength estimator is installed. */
  get hasStrengthScore(): boolean {
    return this.zxcvbn !== null;
  }

  /** The policy in force, for an error message that states the rule being broken. */
  get policy(): PasswordPolicyConfig {
    return this.config;
  }

  /**
   * Checks a password.
   *
   * Synchronous today and asynchronous from the breach check onwards. The signature
   * is already a promise so that adding a network call later is not a breaking
   * change at every call site — a caller that `await`s this compiles unchanged.
   */
  async check(password: string): Promise<PasswordCheckResult> {
    // First, and alone: a password that fails the length rule is not going to pass
    // a breach check, and asking anyway spends a network call to learn nothing.
    const format = checkPasswordFormat(password, this.config);

    if (!format.ok) {
      return format;
    }

    const score = this.scoreStrength(password);

    if (score !== null && score < MINIMUM_ACCEPTABLE_SCORE) {
      return {
        ok: false,
        reasons: [
          score === 0
            ? 'This password is too easy to guess. Try several unrelated words, or a longer random string.'
            : 'This password is too easy to guess. Add length or unpredictability.',
        ],
      };
    }

    return { ok: true, reasons: [] };
  }

  /**
   * The strength score, or `null` when the package is absent or threw.
   *
   * `null` rather than a passing zero on purpose. The alternative is that a
   * deployment which never installed the package rejects every password with "too
   * easy to guess", which is a far worse failure than a policy that quietly omits
   * one of its checks.
   */
  private scoreStrength(password: string): number | null {
    if (this.zxcvbn === null) {
      return null;
    }

    try {
      return this.zxcvbn(password).score;
    } catch (error) {
      // A broken optional package must not take signup down. Logged rather than
      // swallowed silently, because a package that fails on every call is a bug
      // someone needs to see rather than a feature that is simply off.
      this.logger.warn(
        `zxcvbn could not score a password, skipping the check: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return null;
    }
  }
}
