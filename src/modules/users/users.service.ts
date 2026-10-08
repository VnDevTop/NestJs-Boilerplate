import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { authUserKey, CacheService } from '../../core/cache/index.js';
import type { CacheConfig } from '../../configs/index.js';
import { ConfigService } from '@nestjs/config';

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
} as const;

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly cache: CacheService,
    private readonly configService: ConfigService,
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
        };
      },
      { ttl: this.authTtl },
    );
  }

  /**
   * Drops one user's cached claims.
   *
   * Every write that could change an authentication answer calls this, and the
   * list is deliberately short: the role, the active flag, the manager flag, the
   * address, and the sessions version. Anything else about a user can change
   * without touching the cache.
   */
  async invalidateAuthCache(userId: string): Promise<void> {
    await this.cache.delete(authUserKey(userId));
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
    const savedUser = await this.usersRepository.save(updatedUser);

    // Unconditional rather than only when a claim field moved. The cached entry
    // holds none of the fields this endpoint actually edits, so the common case
    // costs one cache delete and keeps the check out of the path where forgetting
    // it would leave a demotion in force for the rest of the TTL.
    await this.invalidateAuthCache(id);

    return UserResponseDto.fromEntity(savedUser);
  }

  async softDelete(id: string): Promise<void> {
    const user = await this.findById(id);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.usersRepository.softDelete(id);

    // A soft-deleted account must stop authenticating now, not when its cached
    // claims expire. `JwtStrategy` reads `isActive`, which a soft delete does not
    // touch, so nothing downstream would otherwise notice.
    await this.invalidateAuthCache(id);
  }
}
