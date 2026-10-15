import { randomBytes, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  IsNull,
  MoreThan,
  Repository,
} from 'typeorm';

import { hashToken } from '../../common/utils/index.js';
import type { AccountSecurityConfig } from '../../configs/account-security.config.js';
import { ACCOUNT_SECURITY } from '../../configs/account-security.config.js';
import type { AppConfig } from '../../configs/app.config.js';
import type { User } from '../users/entities/index.js';
import { UsersService } from '../users/users.service.js';
import { AccountUnlockToken } from './entities/index.js';
import { LoginLockoutService } from './login-lockout.service.js';
import { MailService } from '../mail/index.js';
import {
  dedupeKey,
  JOB_QUEUE,
  MAIL_JOB,
  QUEUE_NAMES,
  type JobQueue,
  type MailJobPayload,
} from '../queue/index.js';

const logger = new Logger('AccountLockService');

export interface IssuedUnlockToken {
  /** Plaintext, sent once in the email and never stored. */
  token: string;
  expiresAt: Date;
}

/**
 * The permanent lockout, and the two ways out of it.
 *
 * Phase 17a's `LoginLockoutService` already blocks sign-in for a few minutes after
 * repeated failures. That one lives in redis, expires on its own, and answers an
 * attack in progress. This one writes `users.lockedAt`, which nothing clears on its
 * own, and answers an attack that has already been going for a day.
 *
 * **Why it is not simply a longer `LoginLockoutService`.** A block that only ever
 * lifts itself is not a lockout, it is a delay, and an attacker who can outlast the
 * delay has an unlimited supply of attempts. This one ends the attempt, and the cost
 * of that is a person who cannot sign in until they or an operator clear it.
 * Everything below is about keeping that cost survivable.
 *
 * ## The denial of service, stated plainly
 *
 * A permanent lockout is a weapon. Five wrong passwords do not lock an account;
 * twenty do, and twenty requests is nothing. Somebody with a list of addresses can
 * lock every account in a deployment for the cost of the list.
 *
 * Three things bound that:
 *
 * 1. **Only a confirmed address can be locked.** An unverified account has never
 *    proved it can read its mail, so a lock on it would be unrecoverable without an
 *    operator — which is refusing it service for nothing, since the temporary block
 *    already applies to it.
 * 2. **The owner can always clear it.** The mail goes to the confirmed address, so
 *    the person under attack, not the person running the attack, holds the way back
 *    in. This is why the recovery path is an emailed link and not a support ticket.
 * 3. **An operator can always clear it.** `AccountLockController`'s admin route, for
 *    when the address itself is gone.
 *
 * What is left is a nuisance an attacker can inflict, on an account that can get
 * itself back in without help. That is the trade, and it is cheaper than the
 * alternative: an account nobody can lock is an account nobody can defend.
 *
 * **The login response says nothing.** A locked account and an address nobody
 * registered get the same 401. A response that differed would answer "which
 * addresses exist" to anyone willing to burn twenty requests, which is the whole
 * enumeration question Phase 13 works to keep shut. The owner finds out from the
 * mail instead — the only channel that reaches the one person who can act on it.
 */
@Injectable()
export class AccountLockService {
  constructor(
    @InjectRepository(AccountUnlockToken)
    private readonly unlockTokens: Repository<AccountUnlockToken>,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    private readonly dataSource: DataSource,
    private readonly usersService: UsersService,
    private readonly loginLockout: LoginLockoutService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
    @Inject(ACCOUNT_SECURITY)
    private readonly config: AccountSecurityConfig,
  ) {}

  private get store(): EntityManager {
    return this.unlockTokens.manager;
  }

  private get appConfig(): AppConfig {
    return this.configService.getOrThrow<AppConfig>('app');
  }

  private get ttlMs(): number {
    return this.config.unlockTokenTtlHours * 60 * 60 * 1000;
  }

  /**
   * Locks the account behind `email` if the failure count says it should.
   *
   * Called on every failed sign-in, so the cheap path is the early return: two
   * comparisons and no query. The lookup happens only on the attempt that crosses
   * the threshold, which is once per attack rather than once per guess.
   *
   * `failures === threshold` rather than `>=`. Two requests can read the same count
   * and both believe they are the one that crossed; `lockAccount` settles the race
   * by refusing a second write, and an `===` means the slower request skips the
   * lookup entirely.
   */
  async lockOnRepeatedFailures(email: string, failures: number): Promise<void> {
    const threshold = this.config.permanentLockThreshold;

    // Zero, or at or below the temporary threshold: disabled.
    //
    // The second half is a guard against a configuration rather than a state. At or
    // below the temporary threshold the permanent lock would fire on the very
    // attempt that starts the temporary block, and the temporary block lifts on its
    // own — so the account would be locked and unlocked minutes apart with an email
    // in between, which is an outage wearing a lockout's clothes. Treating it as
    // off is quieter than locking and immediately ignoring ourselves.
    //
    // Asked of `loginLockout` rather than read from the `LOCKOUT_THRESHOLD` export,
    // because the export is now only the default: an operator who raised
    // `LOGIN_MAX_FAILED_ATTEMPTS` to 10 and left `ACCOUNT_PERMANENT_LOCK_THRESHOLD`
    // at 20 gets a working temporary lock, and comparing against a hard-coded 5
    // would have disabled the permanent one entirely.
    const temporaryThreshold = this.loginLockout.threshold;

    if (threshold <= temporaryThreshold || failures !== threshold) {
      return;
    }

    const user = await this.usersService.findByEmail(email);

    // The account has to be one whose owner can get back in without an operator.
    if (!user || !user.isActive || !user.isEmailVerified || user.lockedAt) {
      return;
    }

    const reason =
      `${failures} failed sign-in attempts within ` +
      `${this.config.permanentLockWindowHours} hours`;

    try {
      await this.usersService.lockAccount(user.id, reason);
    } catch (error) {
      // The lock failed, so the count keeps climbing and the next attempt tries
      // again. Logged rather than swallowed: a deployment silently not locking a
      // locked-out account is indistinguishable from a deployment nobody is
      // attacking.
      logger.error(
        `Could not lock the account for ${email} after ${failures} failures: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return;
    }

    await this.enqueueUnlockMail(user, failures);
  }

  /**
   * Sends the owner the link that clears the lock.
   *
   * Awaited, unlike most mail in this codebase. The trigger is a rare event on a
   * path that is already refusing the request, so the extra millisecond buys an
   * enqueue that either happened or logged — and a user who unlocks two minutes
   * later to find no mail waiting has no way to tell "not sent" from "not yet".
   *
   * The failure count is a parameter rather than a lookup because redis has long
   * since forgotten it by the time anybody asks, and a mail that says "after some
   * failures" reads like a broken template.
   */
  private async enqueueUnlockMail(
    user: User,
    failures: number | null,
  ): Promise<void> {
    const { token, expiresAt } = await this.issue(user);
    const hours = Math.round((expiresAt.getTime() - Date.now()) / 3_600_000);

    const payload: MailJobPayload = {
      to: user.email,
      template: 'account-permanently-locked',
      data: {
        reason: user.lockReason ?? 'Too many failed sign-in attempts.',
        unlockUrl: this.mailService.buildUrl(
          `/auth/account/unlock/${encodeURIComponent(token)}`,
        ),
        expiresInHours: hours,
        failures,
        appName: this.appConfig.name,
      },
    };

    await this.queue
      .enqueue(QUEUE_NAMES.mail, {
        name: MAIL_JOB,
        payload,
        // Keyed on the token, so a second lock on the same account sends a second
        // mail while a redelivery of the first does not.
        dedupeKey: dedupeKey({
          template: 'account-permanently-locked',
          to: user.email,
          subjectId: token,
        }),
      })
      .catch(() => undefined);
  }

  /**
   * Mints a token for `user` and spends the outstanding ones.
   *
   * Only ever called for an account that is locked and confirmed. A token for
   * anything else would be a way to confirm an inbox on an account that has not
   * proved it can read one, which is exactly what this feature must not be.
   */
  async issue(user: User): Promise<IssuedUnlockToken> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.ttlMs);

    await this.spendOutstandingFor(user.id);

    await this.store.save(
      this.store.create(AccountUnlockToken, {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt,
        usedAt: null,
      }),
    );

    return { token, expiresAt };
  }

  /**
   * Invalidates every token this user holds.
   *
   * Spending rather than deleting, for the reason the other token tables do it: a
   * link already sitting in an inbox has to stop working the moment a newer one is
   * sent, so an older leaked mail cannot be used after the owner has asked again.
   */
  async spendOutstandingFor(userId: string): Promise<void> {
    await this.store.update(
      AccountUnlockToken,
      { userId, usedAt: IsNull() },
      { usedAt: new Date() },
    );
  }

  private async findUsable(
    token: string,
    manager?: EntityManager,
  ): Promise<AccountUnlockToken | null> {
    const found = await (manager ?? this.store).findOne(AccountUnlockToken, {
      where: {
        tokenHash: hashToken(token),
        usedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
    });

    return found ?? null;
  }

  /**
   * Whether a token could be used, without using it.
   *
   * Never called from a route, and that is worth saying: the public request route
   * answers the same way either way, so there is nothing here for it to decide. It
   * exists for the tests and for an operator tool that wants to check a link
   * without spending it.
   */
  async isUsable(token: string): Promise<boolean> {
    return (await this.findUsable(token)) !== null;
  }

  /**
   * Sends the link, if there is an account that both needs it and can receive it.
   *
   * Silent on every miss, and identically silent on each. The caller returns the
   * same message for an unknown address, an unlocked account and an unverified one,
   * and this method does the matching work on the outside so none of that leaks
   * through a timing difference.
   */
  async requestUnlock(email: string): Promise<void> {
    const user = await this.usersService.findByEmail(email);

    if (!user || !user.lockedAt || !user.isEmailVerified) {
      // The same statement the qualifying branch runs, against an id with no rows.
      // Without it the miss is measurably cheaper and response time alone answers
      // the question — the reason `forgot-password` pays for the same thing.
      await this.spendOutstandingFor(randomUUID());

      return;
    }

    // No count here, and not because it was forgotten: redis forgets the failure
    // count within the hour, and a request for an unlock usually comes later than
    // that. The template reads "after too many" rather than inventing a number, and
    // the lock mail — the one that arrives while the number still exists — carries
    // it exactly.
    await this.enqueueUnlockMail(user, null);
  }

  /**
   * Spends a token and clears the lock, in one transaction.
   *
   * One transaction for the reason the password reset is: a crash between the spend
   * and the unlock would leave a lock whose only way out is a token that no longer
   * works, which is the one failure this feature must not have.
   *
   * The same message for an unknown, expired and spent token. A caller that can
   * tell those apart can enumerate which tokens were ever issued.
   */
  async unlockWithToken(token: string): Promise<User> {
    const userId = await this.dataSource.transaction(async (manager) => {
      const record = await this.findUsable(token, manager);

      if (record === null) {
        throw new BadRequestException(
          'This unlock link is invalid or has expired',
        );
      }

      await manager.update(
        AccountUnlockToken,
        { id: record.id },
        { usedAt: new Date() },
      );

      return record.userId;
    });

    const user = await this.usersService.unlockAccount(
      userId,
      'the account owner',
    );

    // The redis reset is not optional here, and skipping it is a bug with a nasty
    // symptom: the count is at its maximum at the moment of the lock, so an owner
    // who clicks their own link would be told they are unlocked and then refused a
    // 429 for the rest of a temporary block they never knew about.
    await this.loginLockout.reset(user.email);

    // No mail. They clicked the link; they know. A message confirming an action the
    // person just took is noise in the one inbox they are watching for exactly this.
    return user;
  }

  /**
   * Clears a lock on somebody's behalf.
   *
   * The admin path, and the reason the controller route exists in this module rather
   * than in `users`: clearing the lock also has to clear the redis failure count,
   * and `LoginLockoutService` lives in `auth`. Putting the route in the users
   * module would mean `UsersModule` importing `AuthModule`, which imports it right
   * back.
   *
   * The redis reset is not optional, and skipping it is a bug with a nasty symptom:
   * the owner clicks their link, is told they are unlocked, and is then refused a
   * 429 for the remainder of a temporary block they never knew about. The count is
   * at its maximum at the moment of the lock, so this is the normal path and not a
   * corner.
   */
  async clear(userId: string, actor: string): Promise<User> {
    const user = await this.usersService.unlockAccount(userId, actor);

    // Best effort, and the reason is worth stating: `LoginLockoutService.reset`
    // swallows its own failures and returns void, so there is nothing here to catch.
    // If a future redis-backed reset can reject, it needs to catch — an unlock that
    // failed because of a cache outage would strand the one account this feature
    // exists to get people back into.
    await this.loginLockout.reset(user.email);

    // An operator opening somebody's account is news to the owner. It is the one
    // place a lock is cleared by someone who is not the owner, and an account that
    // recovers itself silently is an account the owner cannot account for.
    await this.enqueueUnlockedMail(user.email, actor);

    return user;
  }

  /**
   * Tells the person their account is usable again.
   *
   * Sent on the admin path only. The self-service path needs no confirmation: the
   * person clicking the link already knows, and a mail that says "your account is
   * unlocked" because they unlocked it is noise in an inbox they are watching for
   * exactly this kind of message.
   */
  private async enqueueUnlockedMail(to: string, actor: string): Promise<void> {
    const payload: MailJobPayload = {
      to,
      template: 'account-unlocked',
      data: {
        actor,
        supportUrl: this.mailService.buildUrl('/support'),
        appName: this.appConfig.name,
      },
    };

    await this.queue
      .enqueue(QUEUE_NAMES.mail, {
        name: MAIL_JOB,
        payload,
        // No subject id: two unlocks by two different operators are two events. The
        // dedupe key exists to stop one enqueue being delivered twice.
        dedupeKey: dedupeKey({
          template: 'account-unlocked',
          to,
          subjectId: `${actor}:${Date.now()}`,
        }),
      })
      .catch(() => undefined);
  }
}
