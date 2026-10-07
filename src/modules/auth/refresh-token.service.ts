import { randomUUID } from 'node:crypto';

import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModuleOptions, JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  IsNull,
  MoreThan,
  Repository,
} from 'typeorm';

import { RefreshTokenRevokedReason } from './enums/index.js';
import { RefreshToken } from './entities/index.js';
import { RefreshTokenPayload, TokenMetadata } from './types/index.js';

export interface IssuedRefreshToken {
  token: string;
  record: RefreshToken;
}

@Injectable()
export class RefreshTokenService {
  constructor(
    @InjectRepository(RefreshToken)
    private readonly refreshTokensRepository: Repository<RefreshToken>,
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  private get store(): EntityManager {
    return this.refreshTokensRepository.manager;
  }

  private get jwtOptions(): JwtModuleOptions {
    return this.configService.getOrThrow<JwtModuleOptions>('jwtRefreshToken');
  }

  private get secret(): string | Buffer {
    const { secret } = this.jwtOptions;

    if (typeof secret === 'string' || Buffer.isBuffer(secret)) {
      return secret;
    }

    throw new Error('JWT refresh token secret is not configured');
  }

  async runInTransaction<T>(
    handler: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(handler);
  }

  async issue(
    userId: string,
    metadata: TokenMetadata,
    deviceId: string | null = null,
    manager: EntityManager = this.store,
  ): Promise<IssuedRefreshToken> {
    const jti = randomUUID();

    const token = await this.jwtService.signAsync(
      { sub: userId, jti } satisfies RefreshTokenPayload,
      {
        ...this.jwtOptions.signOptions,
        secret: this.secret,
      },
    );

    const { exp } = this.jwtService.decode<RefreshTokenPayload>(token);

    const record = manager.create(RefreshToken, {
      userId,
      jti,
      expiresAt: new Date((exp ?? 0) * 1000),
      revokedAt: null,
      revokedReason: null,
      replacedById: null,
      deviceId,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
    });

    return { token, record: await manager.save(record) };
  }

  verify(
    token: string,
    options: { ignoreExpiration?: boolean } = {},
  ): RefreshTokenPayload {
    try {
      return this.jwtService.verify<RefreshTokenPayload>(token, {
        secret: this.secret,
        ignoreExpiration: options.ignoreExpiration ?? false,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  findByJti(
    jti: string,
    manager: EntityManager = this.store,
    lock = false,
  ): Promise<RefreshToken | null> {
    return manager.findOne(RefreshToken, {
      where: { jti },
      lock: lock ? { mode: 'pessimistic_write' } : undefined,
    });
  }

  /**
   * The live refresh tokens of one user, newest first.
   *
   * A session is one live refresh token, not one device. Rotation issues a new
   * row per refresh and marks the previous one revoked, so a device has a chain
   * of rows behind it and exactly one of them is live. That live row is the
   * session: the thing whose id the caller passes to revoke it.
   *
   * Expired rows are filtered in the query rather than left for the caller to
   * notice. A session whose token expired an hour ago is not something anybody
   * can act on, and listing it invites a revoke call that would look like it
   * worked.
   */
  async listLiveByUserId(userId: string): Promise<RefreshToken[]> {
    return this.refreshTokensRepository.find({
      where: { userId, revokedAt: IsNull(), expiresAt: MoreThan(new Date()) },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Revokes one live session belonging to `userId`.
   *
   * Scoped by owner on purpose. Looking the row up by id alone would let a caller
   * who guessed another user's session id terminate that session: the id is a
   * uuid in a response only its owner ever saw, which is exactly the kind of
   * secret that leaks through a log line or a referrer.
   *
   * Revoked atomically against `revokedAt IS NULL`, so two devices racing to drop
   * the same session do not both report success and overwrite each other's reason.
   * A session that is already gone is a 404 rather than a silent no-op, because
   * "I revoked it" when it was already revoked is an answer nobody asked for.
   */
  async revokeByIdForUser(
    userId: string,
    id: string,
    reason: RefreshTokenRevokedReason,
  ): Promise<void> {
    const result = await this.refreshTokensRepository.update(
      { id, userId, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedReason: reason },
    );

    if (result.affected === 0) {
      throw new NotFoundException('Session not found');
    }
  }

  async revokeByJti(
    jti: string,
    reason: RefreshTokenRevokedReason,
    replacedById: string | null = null,
    manager: EntityManager = this.store,
  ): Promise<void> {
    await manager.update(
      RefreshToken,
      { jti, revokedAt: IsNull() },
      {
        revokedAt: new Date(),
        revokedReason: reason,
        replacedById,
      },
    );
  }

  async revokeAllByDeviceId(
    deviceId: string,
    reason: RefreshTokenRevokedReason,
    manager: EntityManager = this.store,
  ): Promise<number> {
    const result = await manager.update(
      RefreshToken,
      { deviceId, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedReason: reason },
    );

    return result.affected ?? 0;
  }

  async revokeAllByUserId(
    userId: string,
    reason: RefreshTokenRevokedReason,
    manager: EntityManager = this.store,
  ): Promise<number> {
    const result = await manager.update(
      RefreshToken,
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedReason: reason },
    );

    return result.affected ?? 0;
  }
}
