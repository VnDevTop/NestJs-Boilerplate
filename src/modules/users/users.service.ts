import {
  ConflictException,
  Injectable,
  Logger,
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

import { PaginatedResultDto } from '../../common/pagination/index.js';
import { buildCriteria, readPage } from '../../common/query/index.js';
import {
  parseSearchQuery,
  toRawQuery,
  translateToFacet,
  translateToFullText,
  type SearchQuery,
} from '../../common/search/index.js';
import { DEFAULT_LIMIT } from '../../common/constants/index.js';

import { hashPassword } from '../../common/utils/index.js';

import { NotificationEventsService } from '../notification/notification-events.service.js';
import { NotificationPreferencesService } from '../notification/notification-preferences.service.js';
import {
  CreateUserDto,
  ListUsersQueryDto,
  UpdateUserDto,
  UserResponseDto,
  UserSearchDto,
  UserSearchResultDto,
  type FacetCountDto,
} from './dto/index.js';
import { USER_QUERY_SPEC } from './dto/user-query.js';
import { USER_SEARCH_FIELDS } from './users-search.js';
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
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly cache: CacheService,
    private readonly configService: ConfigService,
    private readonly notifications: NotificationEventsService,
    private readonly preferences: NotificationPreferencesService,
  ) {}

  private get authTtl(): number {
    return this.configService.getOrThrow<CacheConfig>('cache').authUserTtl;
  }

  /**
   * The single writer of `users.password`, and it hashes.
   *
   * `createUserDto.password` is a plaintext password. This method used to write
   * the string it was given straight to the repository, and that survived review
   * because its one careful caller pre-hashed first: `AuthService.register` had
   * to hold the digest anyway, to record it in the password history.
   *
   * `POST /users` was the other caller and it had no such reason, so an
   * administrator creating an account persisted the submitted password in clear
   * text — a live credential in the one column the rest of the system assumes
   * holds a scrypt digest.
   *
   * It failed quietly, which is why the suite did not catch it.
   * `verifyPassword` splits the stored value on `:` and returns false when there
   * is no second part, so the account simply could never sign in: the row was
   * created, the response was 200, and nothing ever asked that user to
   * authenticate. A test that only asserted "created" would pass.
   *
   * Returns the entity rather than the response DTO because `register` needs the
   * digest for the history row. Returning the entity where a DTO was returned is
   * deliberate — the alternative is hashing twice, and scrypt is slow on purpose.
   */
  async create(createUserDto: CreateUserDto): Promise<User> {
    const existingUser = await this.findByEmail(createUserDto.email);

    if (existingUser) {
      throw new ConflictException('Email already exists');
    }

    const user = this.usersRepository.create({
      email: createUserDto.email,
      password: await hashPassword(createUserDto.password),
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
    return savedUser;
  }

  /**
   * A page of users, newest first by default.
   *
   * **One call, and the route's whole query surface is declared elsewhere.**
   * `USER_QUERY_SPEC` says which fields may be filtered and sorted and which
   * column each one means; the DTO says what the request may contain; this
   * method hands both to the query layer and reads a page. There is no `if` per
   * filter here, and there is no way for a filter to be added to one of those
   * two places and not the other.
   *
   * **The values are bound and the columns are not.** The `email` substring is
   * a parameter, so the `%` and `_` a caller types are searched for literally
   * rather than acting as wildcards — a search box that treats `_` as "any
   * character" is a box that returns rows nobody asked for.
   *
   * No `total`, deliberately. See `PageMetaDto`: the honest paging answer is the
   * one carried by the page itself, and a count over the same rows is a second
   * query that goes stale between pages.
   */
  async findAll(
    query: ListUsersQueryDto,
  ): Promise<PaginatedResultDto<UserResponseDto>> {
    const criteria = buildCriteria(query, USER_QUERY_SPEC);

    const page = await readPage({
      query: this.usersRepository.createQueryBuilder('user'),
      criteria,
      alias: 'user',
    });

    return PaginatedResultDto.of(
      UserResponseDto.fromEntities(page.items),
      page.meta,
    );
  }

  /**
   * The users that match a search, best first.
   *
   * **The query is the search language, and the field map says what it means.**
   * `USER_SEARCH_FIELDS` says which fields exist, which column each one lands
   * on and how much it counts for; the translator turns the tree into a filter
   * and a rank. Nothing here knows what a field is called.
   *
   * **The results and the counts come from the same filter.** The facet counts
   * are the rows the results are drawn from, so the two cannot disagree about
   * what matched — which is the whole reason the facet translator takes the
   * same tree.
   *
   * **No cursor.** A ranked set is not keyset-paged on a column, because the
   * rank is not a column: a boundary on a floating-point score is a boundary
   * that can be equal or not by a rounding error, and a page that repeats a
   * row or skips one is worse than a search that says "here are the best
   * twenty". A client that needs a specific set filters instead — the filters
   * are exact, and `GET /users` pages over a column.
   */
  async search(query: UserSearchDto): Promise<UserSearchResultDto> {
    const tree = parseSearchQuery(query.query);
    const { filter, rank, parameters } = translateToFullText(
      tree,
      USER_SEARCH_FIELDS,
      {
        alias: 'user',
      },
    );

    const limit = query.limit ?? DEFAULT_LIMIT;

    const { entities, raw } = await this.usersRepository
      .createQueryBuilder('user')
      // The rank is selected rather than computed twice, so the score in the
      // answer and the order of the rows are the same number.
      .addSelect(rank, 'score')
      .where(filter)
      .setParameters(parameters)
      .orderBy('score', 'DESC')
      // The id breaks the tie, so two rows with the same score have one order
      // rather than two.
      .addOrderBy('user.id', 'DESC')
      .limit(limit)
      .getRawAndEntities();

    const items = entities.map((user, index) => ({
      ...UserResponseDto.fromEntity(user),
      score: Number(raw[index]?.score ?? 0),
    }));

    const facets: Record<string, FacetCountDto[]> = {};

    for (const field of query.facets ?? []) {
      facets[field] = await this.countFacet(tree, field);
    }

    return { items, facets };
  }

  /**
   * The counts of the matching rows, grouped by one field.
   *
   * **The same filter as the results**, because a count of a different set of
   * rows is a number about one thing next to a list about another.
   */
  private async countFacet(
    tree: SearchQuery,
    field: string,
  ): Promise<FacetCountDto[]> {
    const { sql, parameters } = translateToFacet(
      tree,
      USER_SEARCH_FIELDS,
      field,
      { table: 'users', alias: 'user' },
    );

    // The raw call takes positional placeholders rather than named ones, so the
    // fragment is rewritten before it is run. The values stay parameters.
    const raw = toRawQuery(sql, parameters);

    const rows = (await this.usersRepository.query(
      raw.sql,
      raw.values,
    )) as Array<{ value: string | null; count: number }>;

    return rows.map((row) => ({
      value: row.value,
      count: Number(row.count),
    }));
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
   *
   * A `password` in the body is a plaintext password, hashed here exactly as
   * `create` does — the client holds the raw string and the service owns the
   * digest, so there is one writer of the column and one contract for it. It also
   * bumps `sessionsVersion`, which is the part that is easy to leave out: an
   * administrator resetting a password somebody cannot reach their inbox from is
   * closing a door the old key still opens, and every session minted under that
   * key would otherwise keep working for the rest of its lifetime.
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

    // Destructured rather than merged as received. `merge` assigns every key it is
    // handed, so passing the DTO through with `password` still on it would write
    // the plaintext regardless of anything decided above — the one way this fix
    // could silently not apply.
    const { password, ...edits } = updateUserDto;

    const changes: Partial<User> = { ...edits };

    if (password !== undefined) {
      changes.password = await hashPassword(password);
      changes.sessionsVersion = user.sessionsVersion + 1;
    }

    const updatedUser = this.usersRepository.merge(user, changes);

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

    // Truthy rather than `!== null`, for the same reason as `requestDeletion`: an
    // `undefined` lock is not a lock, and treating it as one would make every
    // account look permanently locked to a caller holding a partial row.
    if (user.lockedAt) {
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

    if (!user.lockedAt) {
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
   * The right to erasure: soft delete, with the reason, and stop authenticating.
   *
   * **Soft, not hard.** The row stays for the retention window — thirty days by
   * default — so a deletion made in anger, or by somebody who got an account
   * closed on them, can be reversed by an operator. Erasing immediately would make
   * the feature irreversible, which is the wrong property for an endpoint anybody
   * can call.
   *
   * The reason goes through the entity's own `requestDeletion`, so `deletedAt` and
   * `deletionReason` are set together and nothing else can set one without the
   * other. The timestamp is what the retention job measures the thirty days from.
   *
   * `runThenInvalidateAuthCache`, not a bare `softDelete`, for the same reason the
   * lock uses it: a soft delete leaves `isActive` alone, so nothing downstream would
   * notice an erased account until its cached claims expired.
   */
  async requestDeletion(
    id: string,
    reason: string,
    actor: string,
  ): Promise<User> {
    const user = await this.findById(id);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Truthy rather than `!== null`. Both are falsy for an un-erased account, but
    // `undefined` is neither `null` nor a Date, and a row that has never been
    // mapped — a partial select, an entity built by hand — would otherwise read as
    // already deleted and the request would silently do nothing.
    if (user.deletedAt) {
      // Idempotent, and deliberately silent. An erasure request that is retried —
      // by a client that lost the response, or by a person clicking twice — must
      // not restart the thirty-day clock, or a user could hold their account in a
      // half-erased state indefinitely by requesting once a day.
      return user;
    }

    user.requestDeletion(reason);

    const erased = await this.runThenInvalidateAuthCache(id, () =>
      this.usersRepository.save(user),
    );

    // Notification preferences go now rather than with the retention job, so the
    // erasure is complete on the day it is asked for while the user row is still
    // recoverable for thirty days. A channel choice is not part of the person, and
    // restoring an account should not restore "email me about this" for an address
    // that was just erased.
    try {
      await this.preferences.forget(id);
    } catch (error) {
      // Logged rather than thrown: the account is already marked, so failing here
      // would leave a caller believing the erasure did not happen, and retrying it
      // would not un-mark the row. These rows are configuration with no security
      // value; the audit trail and the notification are the parts that matter.
      this.logger.error(
        `Could not remove notification preferences for the erased account ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await this.notifications.notify(
      'user.deleted',
      { email: erased.email, actor },
      { userId: id },
    );

    return erased;
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
    // No lookup here. `requestDeletion` does its own — the id, not the row — and a
    // second one would consume a second row from a repository that pages, which in
    // a real database costs a query and in a test harness reads as a user that does
    // not exist.
    //
    // The reason defaults to something that says who did it, because this is the
    // administrative path and the row has to explain itself after the hard delete.
    await this.requestDeletion(id, 'deleted by an administrator', actor);
  }
}
