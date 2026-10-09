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

import { revokedSessionKey, CacheService } from '../../core/cache/index.js';

import { RefreshTokenRevokedReason } from './enums/index.js';
import { RefreshToken } from './entities/index.js';
import { RefreshTokenPayload, TokenMetadata } from './types/index.js';

/**
 * Used when the access token lifetime cannot be read.
 *
 * Matches the default of `JWT_EXPIRES_IN`, and deliberately the same number rather
 * than a shorter one: an entry that expires early lets a revoked session's access
 * tokens start working again, so the fallback errs long.
 */
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 900;

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
    private readonly cache: CacheService,
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
  /**
   * Revokes one session by row id, and hands back its `jti`.
   *
   * The caller needs the jti, not the row id, because that is what the access
   * token minted alongside this session carries. Returning it here rather than
   * reading it back afterwards keeps the whole revocation on one statement, and
   * `RETURNING` means no second round trip to learn what was just revoked.
   */
  async revokeByIdForUser(
    userId: string,
    id: string,
    reason: RefreshTokenRevokedReason,
  ): Promise<string> {
    const result = await this.refreshTokensRepository
      .createQueryBuilder()
      .update()
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where({ id, userId, revokedAt: IsNull() })
      .returning('jti')
      .execute();

    if (result.affected === 0) {
      throw new NotFoundException('Session not found');
    }

    // A driver reports the rows it attempted on some configurations and the rows
    // it kept on others, and with `RETURNING` the jtis arrive in `raw`. An empty
    // answer here would mean the access token could not be stopped, so it is
    // reported rather than defaulted: the session is revoked in the database and
    // the caller needs to know the half that did not happen.
    const jti = result.raw?.[0]?.jti as string | undefined;

    if (typeof jti !== 'string' || jti.length === 0) {
      throw new Error(
        'Session was revoked but its jti was not returned, so its access token was not stopped',
      );
    }

    return jti;
  }

  /**
   * Whether an access token's session has been revoked.
   *
   * One key per session, written when the session is revoked and read on every
   * request whose token names a session. There is no key to invalidate and
   * nothing to refill from: a revoked session is recorded *here* rather than
   * derived from the database, because nothing in the database can be looked up by
   * jti on the request path without a query per request, which is the cost this
   * cache exists to remove.
   *
   * The entry outlives the tokens it revokes and then expires on its own: an
   * access token cannot outlive its own expiry, so once this is gone there is
   * nothing left for it to protect.
   */
  async isSessionRevoked(sessionId: string): Promise<boolean> {
    return (await this.cache.get(revokedSessionKey(sessionId))) !== undefined;
  }

  /**
   * Records a session as revoked, for as long as its access tokens can live.
   *
   * A plain write rather than a cache invalidation, because this is the record
   * itself. Every other cached answer about a user can be dropped and refilled;
   * dropping this one would hand the session back.
   */
  async markSessionRevoked(sessionId: string): Promise<void> {
    await this.cache.set(revokedSessionKey(sessionId), true, {
      ttl: await this.accessTokenTtlSeconds(),
      // Exact, because an entry that expires before the tokens it revokes lets
      // those tokens start working again. The jitter every other entry gets exists
      // to spread a burst of expirations, which is worth nothing here and would
      // take up to a tenth of the window off the bottom.
      exactTtl: true,
    });
  }

  /**
   * The access token lifetime in seconds, which is how long a revoked session has
   * to be remembered.
   *
   * Asked of the signer rather than parsed out of the config string. `expiresIn`
   * accepts `'15m'`, `'1h'` and a plain number, and `Number('15m')` is `NaN`, so a
   * parser written here would have to agree with the JWT library about every
   * format it supports. Signing one throwaway token and reading `exp - iat` off it
   * cannot drift from what the access tokens actually get.
   *
   * A probe per revocation rather than a cached number: revocations are rare, and
   * a cached value is one more thing to keep in step with the config.
   */
  private async accessTokenTtlSeconds(): Promise<number> {
    const configured =
      this.configService.get<JwtModuleOptions>('jwtAccessToken')?.signOptions
        ?.expiresIn ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;

    try {
      const probe = await this.jwtService.signAsync(
        { probe: true },
        { expiresIn: configured },
      );
      const { iat, exp } = this.jwtService.decode<{
        iat?: number;
        exp?: number;
      }>(probe);

      if (typeof iat === 'number' && typeof exp === 'number' && exp > iat) {
        return exp - iat;
      }
    } catch {
      // Falls through to the default below rather than throwing. This is the
      // lifetime of a revocation entry, and refusing to record a revocation
      // because the config could not be read would leave an access token alive.
    }

    return DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
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
