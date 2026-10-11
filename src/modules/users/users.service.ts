import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OptimisticLockVersionMismatchError, Repository } from 'typeorm';

import {
  authDeviceSessionsKey,
  authUserKey,
  CacheService,
} from '../../core/cache/index.js';
import type { CacheConfig } from '../../configs/index.js';
import { ConfigService } from '@nestjs/config';

import { NotificationEventsService } from '../notification/notification-events.service.js';
import { CreateUserDto, UpdateUserDto, UserResponseDto } from './dto/index.js';
import { User } from './entities/index.js';

/**
 * Everything the strategy needs to authorise a request, and nothing else.
 *
 * A projection rather than the `User` entity because the entity carries the
 * password hash. Caching the row the strategy reads would put every bcrypt hash
 * in redis, which is offline cracking material in a store that is usually less
 * protected than the database it duplicates. The strategy does not use the hash,
 * so the hash is not selected: the column never leaves postgres for that path.
 *
 * `sessionsVersion` is here even though `RequestUser` does not carry it, because
 * the strategy compares the token's claim against it and that comparison is what
 * makes logout-everywhere immediate.
 */
export interface AuthClaims {
  id: string;
  email: string;
  role?: string;
  isManager: boolean;
  isActive: boolean;
  sessionsVersion: number;
  /**
   * Read live rather than carried in the token.
   *
   * Everything else here is a claim, because those change only when a session is
   * revoked. This one changes when somebody clicks a link, and a token minted
   * before the click would keep saying "unverified" for the rest of its life — long
   * enough that a gate built on it reads as broken. The column is already in the
   * cached projection, so it costs nothing extra.
   */
  isEmailVerified: boolean;
  /**
   * When the account was locked permanently, or null.
   *
   * A timestamp rather than a boolean, because the same reasons that put
   * `isEmailVerified` here apply and one is stronger: a lock is a fact an
   * operator needs to see the date of. A boolean would have to be paired with
   * another column read from the row to be worth anything.
   *
   * The strategy refuses a locked account outright, which is the only thing that
   * makes a permanent lock permanent. Without it, every session that existed
   * before the lock would carry on working until its access token ran out, and
   * the lockout would be an inconvenience rather than a lockout.
   */
  lockedAt: string | null;
}

/**
 * Columns a cached claim set is built from.
 *
 * Listed rather than omitted-by-exclusion so a column added to `User` is not
 * added here by accident.
 */
const AUTH_CLAIM_COLUMNS = {
  id: true,
  email: true,
  role: true,
  isManager: true,
  isActive: true,
  sessionsVersion: true,
  isEmailVerified: true,
  lockedAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly cache: CacheService,
    private readonly configService: ConfigService,
    private readonly notifications: NotificationEventsService,
  ) {}

  private get authTtl(): number {
    return this.configService.getOrThrow<CacheConfig>('cache').authUserTtl;
  }

  async create(createUserDto: CreateUserDto): Promise<UserResponseDto> {
    const existingUser = await this.findByEmail(createUserDto.email);

    if (existingUser) {
      throw new ConflictException('Email already exists');
    }

    const user = this.usersRepository.create({
      email: createUserDto.email,
      password: createUserDto.password,
      firstName: createUserDto.firstName ?? null,
      lastName: createUserDto.lastName ?? null,
      role: createUserDto.role,
      isActive: createUserDto.isActive,
      isManager: createUserDto.isManager,
    });

    const savedUser = await this.usersRepository.save(user);

    // No invalidation, because there is nothing to invalidate: the id is a fresh
    // uuid, so no entry for it has ever been written and the only one that could
    // be a "no such user" placeholder that this uuid cannot have been asked about.
    return UserResponseDto.fromEntity(savedUser);
  }

  async findAll(): Promise<UserResponseDto[]> {
    const users = await this.usersRepository.find({
      order: {
        createdAt: 'DESC',
      },
    });

    return UserResponseDto.fromEntities(users);
  }

  async findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: {
        id,
      },
    });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: {
        email,
      },
    });
  }

  /**
   * The claims behind an authenticated request, read through the cache.
   *
   * This is the read the whole cache exists for: it runs on every authenticated
   * request, and before Phase 17b it was a database round trip each time.
   *
   * A miss is a miss, not an error. `CacheService` already turns a failing store
   * into a miss, so an unreachable redis costs the query it was meant to save and
   * nothing else. That is the whole failover story, and it is why there is no
   * try/catch here: a local one would swallow the loader's own failures too.
   *
   * A user that does not exist is cached for the short `emptyTtl` rather than the
   * full one. A soft delete drops the entry outright, so the short lifetime is
   * only about ids with no row behind them: a stream of requests for one of those
   * stops querying, while a row created under the same id later still appears
   * promptly. Ids are uuids, so that is a malformed request rather than a race.
   */
  async findAuthClaims(id: string): Promise<AuthClaims | null> {
    return this.cache.wrap<AuthClaims | null>(
      authUserKey(id),
      async () => {
        const user = await this.usersRepository.findOne({
          where: { id },
          select: AUTH_CLAIM_COLUMNS,
        });

        if (!user) {
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          role: user.role,
          isManager: user.isManager,
          isActive: user.isActive,
          // A row predating the column reads as zero rather than undefined,
          // because the strategy compares the token claim against this and
          // `undefined` would refuse every token from a database the migration
          // has not touched.
          sessionsVersion: user.sessionsVersion ?? 0,
          isEmailVerified: user.isEmailVerified,
          // Serialised rather than kept as a `Date`, because the cached value is
          // JSON and a `Date` becomes a string on the way in and a string on the
          // way out. The strategy only tests it against null.
          lockedAt: user.lockedAt ? user.lockedAt.toISOString() : null,
        };
      },
      { ttl: this.authTtl },
    );
  }

  /**
   * Drops one user's cached claims, and their device session versions with them.
   *
   * Every write that could change an authentication answer calls this, and the
   * list is deliberately short: the role, the active flag, the manager flag, the
   * address, and the sessions version. Anything else about a user can change
   * without touching the cache.
   *
   * Two keys rather than one, because a token that presents a device reads both.
   * Dropping the claims alone would leave a revoked device looking valid to the
   * very next request.
   */
  async invalidateAuthCache(userId: string): Promise<void> {
    await this.cache.deleteKeys(
      authUserKey(userId),
      authDeviceSessionsKey(userId),
    );
  }

  /**
   * Runs `work`, then drops the user's cached claims.
   *
   * The pairing matters, and the order matters more.
   *
   * `work` is where a `sessionsVersion` bump belongs, because it has to commit
   * inside the transaction alongside the refresh tokens it is revoking. The cache
   * delete cannot go there: a second request arriving between the delete and the
   * commit reads the row through the old snapshot and caches the version we were
   * revoking, and that entry then survives the full TTL. The window is small and
   * the failure is silent, which is the worst combination there is, so revocation
   * happens strictly after the commit.
   *
   * `finally`, so a rolled back transaction also drops the entry. That costs one
   * reload of a row that never changed, and it removes the case where a failure
   * leaves a stale entry behind with nobody left to delete it.
   */
  async runThenInvalidateAuthCache<T>(
    userId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } finally {
      await this.invalidateAuthCache(userId);
    }
  }

  async findProfileById(id: string): Promise<UserResponseDto> {
    const user = await this.findById(id);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return UserResponseDto.fromEntity(user);
  }

  /**
   * Edits a user, refusing if somebody else got there first.
   *
   * The 409 is the whole feature. Without it the second save would simply overwrite
   * the first, and both callers would see a 200 — which is a lost update that looks
   * like success to everybody involved. `version` on the entity makes TypeORM's
   * `save` match on the version it read, so a row changed underneath affects zero
   * rows and raises `OptimisticLockVersionMismatchError` here.
   *
   * Caught rather than allowed out as a 500: it is a conflict between two requests,
   * not a fault, and a caller that reads 409 knows to reload rather than to page
   * somebody.
   */
  async update(
    id: string,
    updateUserDto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    const user = await this.findById(id);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (updateUserDto.email && updateUserDto.email !== user.email) {
      const existingUser = await this.findByEmail(updateUserDto.email);

      if (existingUser) {
        throw new ConflictException('Email already exists');
      }
    }

    const updatedUser = this.usersRepository.merge(user, updateUserDto);

    let savedUser: User;

    try {
      savedUser = await this.usersRepository.save(updatedUser);
    } catch (error) {
      if (error instanceof OptimisticLockVersionMismatchError) {
        throw new ConflictException(
          'This user was changed by somebody else while you were editing. ' +
            'Reload and try again.',
        );
      }

      throw error;
    }

    // Unconditional rather than only when a claim field moved. The cached entry
    // holds none of the fields this endpoint actually edits, so the common case
    // costs one cache delete and keeps the check out of the path where forgetting
    // it would leave a demotion in force for the rest of the TTL.
    await this.invalidateAuthCache(id);

    return UserResponseDto.fromEntity(savedUser);
  }

  /**
   * Locks an account permanently and tells the operators.
   *
   * **The sessions version moves with it**, which is the part that makes this a
   * lockout rather than a flag. Every access token already issued carries the
   * version it was minted under, so a bump refuses all of them at once. Without
   * it an account could stay usable for the life of its longest-lived refresh
   * chain, which is the attack the lockout exists to stop.
   *
   * The bump goes through `runThenInvalidateAuthCache` rather than a bare save so
   * the cache is dropped *after* the commit. The reverse order leaves a window in
   * which a request reads the old version through a fresh cache entry and that
   * entry then outlives the lock by a full TTL — a lockout with a fifteen minute
   * hole in it, which is the sort of bug that reads as "the lock is flaky".
   *
   * Returns the user as it now stands, so a caller can render a notification from
   * the same read that performed the change rather than from a second query that
   * could disagree with it.
   */
  async lockAccount(id: string, reason: string): Promise<User> {
    const user = await this.findById(id);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.lockedAt !== null) {
      // Idempotent rather than an error: two concurrent failures can both cross the
      // threshold, and the second must not overwrite the reason and the timestamp the
      // operator is about to read.
      return user;
    }

    const locked = await this.runThenInvalidateAuthCache(id, () =>
      this.usersRepository.save(
        this.usersRepository.merge(user, {
          lockedAt: new Date(),
          lockReason: reason,
          sessionsVersion: user.sessionsVersion + 1,
        }),
      ),
    );

    await this.notifications.notify(
      'auth.account.locked',
      { email: locked.email, reason },
      { userId: locked.id },
    );

    return locked;
  }

  /**
   * Clears a permanent lock, whichever hand did the locking.
   *
   * `actor` is a free string rather than an id because the two callers are an
   * administrator and the owner of the inbox, and the reader wants to know which
   * of those two happened rather than to join against a table to find out. An
   * audit entry for the administrative case is Phase 19's next task; this is the
   * notification, which is what the person locked out reads.
   */
  async unlockAccount(id: string, actor: string): Promise<User> {
    const user = await this.findById(id);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.lockedAt === null) {
      // Also idempotent. An unlock link can be clicked twice by an anxious user,
      // and a second write that bumped the sessions version again would sign the
      // person out of the session they had just recovered.
      return user;
    }

    const unlocked = await this.usersRepository.save(
      this.usersRepository.merge(user, {
        lockedAt: null,
        lockReason: null,
      }),
    );

    await this.invalidateAuthCache(id);

    await this.notifications.notify(
      'auth.account.unlocked',
      { email: unlocked.email, actor },
      { userId: unlocked.id },
    );

    return unlocked;
  }

  /**
   * Soft deletes a user and tells the operators.
   *
   * **After the delete, not before**, for the same reason as the cache invalidation
   * below: the notification says the account is gone, and a webhook that is slow
   * enough for the request to be answered first must not describe a state the
   * database has not reached. Sending after the row is marked is also what makes the
   * event meaningful to whoever reads it.
   *
   * The actor is the caller id rather than an address, because the audit trail wants
   * a person and the operator reading the channel wants to know *which* administrator
   * did it — an id resolves to a name in the audit log that Phase 19 adds.
   */
  async softDelete(id: string, actor = 'unknown'): Promise<void> {
    const user = await this.findById(id);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.usersRepository.softDelete(id);

    // A soft-deleted account must stop authenticating now, not when its cached
    // claims expire. `JwtStrategy` reads `isActive`, which a soft delete does not
    // touch, so nothing downstream would otherwise notice.
    await this.invalidateAuthCache(id);

    await this.notifications.notify(
      'user.deleted',
      { email: user.email, actor },
      { userId: id },
    );
  }
}
