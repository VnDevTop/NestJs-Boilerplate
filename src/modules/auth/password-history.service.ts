import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { EntityManager, Repository } from 'typeorm';

import { verifyPassword } from '../../common/utils/index.js';
import { passwordPolicyConfig } from '../../configs/password-policy.config.js';
import {
  PasswordHistoryEntry,
  type PasswordChangeReason,
} from './entities/index.js';

/**
 * Writes and reads the last N password hashes for a user.
 *
 * **The count is a policy value, not a constant.** `PASSWORD_HISTORY_COUNT` of zero
 * disables the feature entirely — including the write, because storing hashes for a
 * policy that will never check them is pure risk: a table of credentials protecting
 * against something nobody asked for.
 *
 * **Trimming happens on write, in the caller's transaction.** Leaving it to a
 * nightly job would mean the window between setting a password and the next cleanup
 * holds N+1 hashes, and the answer to "has this user reused that" would depend on
 * when the question was asked. Trimming inline makes the table's size the policy's
 * size, always, which is also why it needs no retention rule of its own: the only
 * thing that ever removes a row is a newer password pushing it out.
 *
 * **Every check is a scrypt verification.** There is no faster lookup available — a
 * password is a password, and the only way to know whether it matches one of the
 * last N is to derive each candidate. Five by default, so a password change costs
 * five derivations plus one for the new hash. That is the price of the feature, and
 * it is the reason the default is five rather than twenty.
 */
@Injectable()
export class PasswordHistoryService {
  private readonly logger = new Logger(PasswordHistoryService.name);

  constructor(
    @InjectRepository(PasswordHistoryEntry)
    private readonly history: Repository<PasswordHistoryEntry>,
    @Inject(passwordPolicyConfig.KEY)
    private readonly config: ConfigType<typeof passwordPolicyConfig>,
  ) {}

  private get count(): number {
    return this.config.historyCount;
  }

  /**
   * Whether this user has used this password before, within the window.
   *
   * A user with no history is not a reuse, and neither is a deployment with the
   * feature turned off.
   */
  async wasUsedBefore(userId: string, password: string): Promise<boolean> {
    if (this.count <= 0) {
      return false;
    }

    const rows = await this.history.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: this.count,
    });

    for (const row of rows) {
      if (await verifyPassword(password, row.passwordHash)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Records a password and drops the oldest beyond the window.
   *
   * Takes an `EntityManager` where the caller has one, so the insert can join the
   * transaction that changes the password. A history written outside that
   * transaction can disagree with the account: a rolled-back reset would leave the
   * *old* password rejected as "used before" while the account still has it, which
   * locks a user out of credentials they know are correct.
   *
   * Registration has no transaction to join — `UsersService.create` is a single
   * save — so it uses the repository, and the caller orders the write after the user
   * row exists. A history row whose user does not exist would be an orphan the
   * cascade cannot clean up.
   */
  async record(
    userId: string,
    passwordHash: string,
    reason: PasswordChangeReason,
    manager?: EntityManager,
  ): Promise<void> {
    if (this.count <= 0) {
      return;
    }

    const store = manager ?? this.history.manager;

    await store.insert(PasswordHistoryEntry, {
      userId,
      passwordHash,
      reason,
    });

    await this.trim(userId, store);
  }

  /**
   * Drops everything past the newest N.
   *
   * Deleted by id rather than by a `LIMIT` subquery so the count of what goes is
   * visible in the log line, and so a concurrent insert from another process cannot
   * make the offset mean something different than it did when the rows were read.
   * The worst case of losing that race is one row kept or one dropped early, which
   * is a slightly different window rather than a wrong password decision.
   */
  private async trim(userId: string, manager: EntityManager): Promise<void> {
    // `skip`/`take` rather than a query builder's offset: same window, one fewer
    // call, and it reads like every other paged read in this codebase.
    const surplus = await manager.find(PasswordHistoryEntry, {
      where: { userId },
      select: { id: true },
      order: { createdAt: 'DESC' },
      skip: this.count,
    });

    if (surplus.length === 0) {
      return;
    }

    await manager.delete(
      PasswordHistoryEntry,
      surplus.map((row) => row.id),
    );

    this.logger.debug(
      `Trimmed ${surplus.length} password history row(s) for user ${userId}`,
    );
  }
}
