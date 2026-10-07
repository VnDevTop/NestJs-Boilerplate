import { randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  IsNull,
  MoreThan,
  Repository,
} from 'typeorm';

import { PASSWORD_RESET_TOKEN_TTL_MINUTES } from '../../common/constants/index.js';
import { hashPassword, hashToken } from '../../common/utils/index.js';
import { User } from '../users/entities/index.js';
import { PasswordResetToken } from './entities/index.js';
import { RefreshTokenRevokedReason } from './enums/index.js';
import { RefreshTokenService } from './refresh-token.service.js';

const logger = new Logger('PasswordResetService');

export interface IssuedPasswordReset {
  /** Plaintext, sent once in the email and never stored. */
  token: string;
  expiresAt: Date;
}

/**
 * Issues, consumes and enforces password reset tokens.
 *
 * The one rule that shapes this class: a token is spent by writing to a row, so
 * consumption and the password change happen in one transaction. A crash between
 * them would otherwise leave a live token next to a changed password, which is
 * a reset link that still works.
 */
@Injectable()
export class PasswordResetService {
  constructor(
    @InjectRepository(PasswordResetToken)
    private readonly resetTokensRepository: Repository<PasswordResetToken>,
    private readonly dataSource: DataSource,
    private readonly refreshTokenService: RefreshTokenService,
  ) {}

  private get store(): EntityManager {
    return this.resetTokensRepository.manager;
  }

  private get ttlMs(): number {
    return PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000;
  }

  /**
   * Mints a token for a user and invalidates the ones already outstanding.
   *
   * Invalidating first is what makes "the last link always works" true: a user
   * who asked twice has one live link, and an attacker who captured an earlier
   * one has nothing.
   */
  async issue(
    user: User,
    ipAddress: string | null,
  ): Promise<IssuedPasswordReset> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.ttlMs);

    await this.store.update(
      PasswordResetToken,
      { userId: user.id, usedAt: IsNull() },
      { usedAt: new Date() },
    );

    await this.store.save(
      this.store.create(PasswordResetToken, {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt,
        usedAt: null,
        ipAddress,
      }),
    );

    return { token, expiresAt };
  }

  /**
   * Marks every unspent token for a user as spent.
   *
   * Exposed on its own because the miss path of `forgot-password` calls it with
   * an id that has no rows, purely to make the statement cost the same. That is
   * the point: the branch that finds no user has to do the same database work as
   * the branch that does, or the difference is an enumeration oracle that needs
   * no timing statistics to read.
   */
  async spendOutstandingFor(userId: string): Promise<void> {
    await this.store.update(
      PasswordResetToken,
      { userId, usedAt: IsNull() },
      { usedAt: new Date() },
    );
  }

  /**
   * Whether a token could be used, without using it.
   *
   * The result is a boolean rather than the row, because the caller answering
   * "we sent you a mail" must not learn whether the address exists either way.
   */
  async isUsable(token: string): Promise<boolean> {
    const found = await this.findUsable(token);

    return found !== null;
  }

  /**
   * Consumes a token and changes the password, in one transaction.
   *
   * Throws the same message for an unknown, expired and already used token. A
   * caller that can tell those apart can enumerate which tokens were ever
   * issued, and which is a smaller leak than it looks: a token is a live
   * credential until it is used.
   */
  async consume(token: string, newPassword: string): Promise<User> {
    return this.dataSource.transaction(async (manager) => {
      const record = await this.findUsable(token, manager);

      if (record === null) {
        throw new BadRequestException(
          'This reset link is invalid or has expired',
        );
      }

      const user = await manager.findOne(User, {
        where: { id: record.userId },
      });

      if (user === null) {
        // Reachable only if the user was deleted between the lookup and this
        // transaction, which the cascade should have made impossible.
        throw new BadRequestException(
          'This reset link is invalid or has expired',
        );
      }

      user.password = await hashPassword(newPassword);

      const saved = await manager.save(user);

      // Marked spent in the same transaction as the password change, so a crash
      // cannot leave a live token beside a password the sender did not choose.
      await manager.update(
        PasswordResetToken,
        { id: record.id },
        { usedAt: new Date() },
      );

      // Every other session dies with the password. A user resetting because
      // they think someone else has access should not leave that session open.
      await this.refreshTokenService.revokeAllByUserId(
        user.id,
        RefreshTokenRevokedReason.PasswordChanged,
        manager,
      );

      // The access tokens too, in the same transaction. Somebody resetting because
      // they think another person has access must not leave that person's
      // fifteen-minute access token working.
      await manager.increment(User, { id: user.id }, 'sessionsVersion', 1);

      logger.log(`Password reset completed for user ${user.id}`);

      return saved;
    });
  }

  /**
   * The usable-token lookup, and the single definition of "usable": not spent
   * and not expired. Both the check and the consume use it, so they cannot
   * disagree.
   */
  private async findUsable(
    token: string,
    manager: EntityManager = this.store,
  ): Promise<PasswordResetToken | null> {
    return manager.findOne(PasswordResetToken, {
      where: {
        tokenHash: hashToken(token),
        usedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
    });
  }
}
