import { registerAs } from '@nestjs/config';

export type CacheBackend = 'redis' | 'valkey' | 'memory';

export interface CacheConfig {
  backend: CacheBackend;
  /**
   * One connection string, for example
   * `redis://user:password@localhost:6379/0`. Valkey speaks the Redis
   * protocol, so the same scheme is used for both; only `backend` differs. A
   * single URL is the whole connection config on purpose: host, port,
   * credentials, TLS and database all live in it, which is what the Redis
   * client itself takes.
   */
  url: string;
  /** Prepended to every key, so one database can host several applications. */
  keyPrefix: string;
  /** Default entry lifetime in seconds. */
  defaultTtl: number;
  /**
   * Lifetime of a user's cached authentication claims, in seconds.
   *
   * Not the mechanism that makes revocation immediate: the write that revokes
   * drops the entry, so this only bounds how long a missed invalidation can hide
   * a change. It is configurable because that window is a security property, and
   * an operator who has to widen it for a slow query should be able to without a
   * release. Kept short for the same reason.
   */
  authUserTtl: number;
  /**
   * Lifetime of a role's cached permission names, in seconds.
   *
   * Longer than the claims, because a role grants the same names to everybody
   * holding it, so there is one entry per role rather than one per user, and
   * changing a role's grants drops the entry rather than waiting.
   */
  authRoleTtl: number;
  /**
   * Lifetime for a "not found" answer, kept short so a record created right
   * after a lookup is not hidden behind a long negative cache entry.
   */
  emptyTtl: number;
  connectTimeout: number;
}

function toBackend(value: string | undefined): CacheBackend {
  return value === 'memory' || value === 'valkey' ? value : 'redis';
}

export const cacheConfig = registerAs('cache', (): CacheConfig => ({
  backend: toBackend(process.env.CACHE_BACKEND),
  url: process.env.CACHE_URL ?? 'redis://localhost:6379/0',
  keyPrefix: process.env.CACHE_KEY_PREFIX ?? 'app',
  defaultTtl: Number(process.env.CACHE_DEFAULT_TTL ?? 300),
  authUserTtl: Number(process.env.CACHE_AUTH_USER_TTL ?? 60),
  authRoleTtl: Number(process.env.CACHE_AUTH_ROLE_TTL ?? 600),
  emptyTtl: Number(process.env.CACHE_EMPTY_TTL ?? 10),
  connectTimeout: Number(process.env.CACHE_CONNECT_TIMEOUT ?? 2000),
}));
