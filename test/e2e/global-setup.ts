import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DataSource } from 'typeorm';
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from 'testcontainers';

/**
 * Starts the real Postgres and Redis the e2e suite runs against, once, before
 * any test file boots.
 *
 * Why containers rather than a developer's own database: the interesting tests
 * here are about transactions, batching and cache invalidation, and neither a
 * sqlite stand-in nor an already-migrated local instance can answer them. The
 * suite has to see the same engine production runs.
 *
 * Why a `globalSetup` rather than a helper called per file: containers are
 * expensive to start, and every spec booting its own pair would take minutes and
 * fight over ports. They are started once here and stopped when the run ends.
 *
 * Why `GenericContainer` rather than the built-in `PostgreSqlContainer` and
 * `RedisContainer` helpers: those were moved out of the package's main entry
 * point, and reconstructing them is thirty lines of wait strategies and port
 * mapping that the suite would then have to maintain.
 *
 * The URLs are written to a file rather than exported through `process.env`,
 * because global setup runs in the vitest main process while each test file runs
 * in a worker. `harness.ts` reads the file instead, which is also why the
 * environment has to be in place before the module graph that reads it loads.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
export const ENV_FILE = resolve(HERE, '..', '.e2e-env.json');

let postgres: StartedTestContainer | undefined;
let redis: StartedTestContainer | undefined;

/**
 * Opt-out for a machine with no docker runtime.
 *
 * An explicit flag rather than a capability probe: `docker info` on a machine
 * whose daemon is merely slow answers "no" just as reliably as on one where it is
 * absent, and a probe that guesses wrong turns a real failure into a silently
 * skipped suite.
 */
const containersDisabled = (): boolean => process.env.E2E_NO_CONTAINERS === '1';

const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  APP_NAME: 'Boilerplate E2E',
  APP_URL: 'http://localhost:3000',
  // Long enough that a slow assertion cannot trip them, and fixed so a token
  // minted in one spec is still valid in the next.
  JWT_SECRET: 'e2e-jwt-secret-value-that-is-long-enough-32',
  JWT_REFRESH_SECRET: 'e2e-refresh-secret-value-that-is-long-enough-32',
  JWT_EXPIRES_IN: '15m',
  JWT_REFRESH_EXPIRES_IN: '7d',
  TWO_FACTOR_ENABLED: 'false',
  // Deterministic, so the seeder is idempotent across specs and no spec has to
  // discover a generated password.
  ADMIN_EMAIL: 'admin@example.test',
  ADMIN_PASSWORD: 'E2e-admin-password-1',
  SWAGGER_ENABLED: 'false',
  // Nothing in the suite may reach a real provider or a real chat room.
  MAIL_TRANSPORT: 'memory',
  MAIL_FROM: 'e2e@example.test',
  NOTIFICATION_ENABLED: 'false',
  QUEUE_ENABLED: 'false',
  QUEUE_IN_PROCESS_FALLBACK: 'true',
  RETENTION_ENABLED: 'false',
  RETENTION_SCHEDULE: '0 3 * * *',
  // Prefixes unique to the run, so a shared redis cannot leak keys into a
  // parallel job and so a key from the queue can never be read out of the cache.
  CACHE_KEY_PREFIX: 'e2e:cache',
  REDIS_KEY_PREFIX: 'e2e:redis',
};

export async function setup(): Promise<void> {
  if (containersDisabled()) {
    return;
  }

  // An externally supplied address wins. It is what makes the suite runnable on a
  // laptop that already has `docker compose up`, without paying for two more
  // containers on top.
  const externalDatabase = process.env.E2E_DATABASE_URL;
  const externalRedis = process.env.E2E_REDIS_URL;

  const databaseUrl = externalDatabase ?? (await startPostgres());
  const redisUrl = externalRedis ?? (await startRedis());

  await migrate(databaseUrl);

  mkdirSync(HERE, { recursive: true });
  writeFileSync(
    ENV_FILE,
    JSON.stringify(
      {
        ...TEST_ENV,
        DATABASE_URL: databaseUrl,
        DATABASE_SSL: 'false',
        // Separate databases on one server, because the cache and the queue
        // redis are deliberately different namespaces in production, and a suite
        // that shared them could not catch a prefix collision.
        CACHE_URL: toDatabase(redisUrl, 0),
        REDIS_URL: toDatabase(redisUrl, 1),
        QUEUE_REDIS_URL: toDatabase(redisUrl, 2),
        CACHE_BACKEND: 'redis',
      },
      null,
      2,
    ),
  );
}

export async function teardown(): Promise<void> {
  await Promise.all([postgres?.stop(), redis?.stop()]);
  postgres = undefined;
  redis = undefined;
}

async function startPostgres(): Promise<string> {
  postgres = await new GenericContainer('postgres:17-alpine')
    .withEnvironment({
      POSTGRES_DB: 'e2e',
      POSTGRES_USER: 'e2e',
      POSTGRES_PASSWORD: 'e2e',
    })
    .withExposedPorts(5432)
    // `pg_isready` alone answers before the database accepts connections from
    // anything but the socket, which is the classic reason a container is
    // "ready" and the first migration still fails.
    .withWaitStrategy(
      Wait.forLogMessage(
        /database system is ready to accept connections.*/g,
      ).withStartupTimeout(120_000),
    )
    .start();

  const port = postgres.getMappedPort(5432);

  return `postgresql://e2e:e2e@${postgres.getHost()}:${port}/e2e`;
}

async function startRedis(): Promise<string> {
  redis = await new GenericContainer('valkey/valkey:8-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/.*Ready to accept connections.*/))
    .start();

  return `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
}

/**
 * A redis url carries its database in the path, and the server starts on db 0.
 * Appending to an already-qualified url would produce `.../0/1`, which redis
 * reads as a malformed port and refuses.
 */
function toDatabase(redisUrl: string, database: number): string {
  try {
    const url = new URL(redisUrl);
    url.pathname = `/${database}`;
    return url.toString();
  } catch {
    return redisUrl;
  }
}

/**
 * Runs every migration against the fresh database.
 *
 * The classes are imported straight from `src` rather than through the `dist`
 * glob `data-source.ts` uses, because that one belongs to the CLI and this suite
 * runs before anything has been built. Deriving the list from the directory
 * means a migration added without a matching entry is a failing suite rather
 * than a schema that is quietly one table short.
 */
async function migrate(databaseUrl: string): Promise<void> {
  const { ENTITIES } = await import('../../src/database/data-source.js');

  const dataSource = new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: ENTITIES,
    migrations: loadMigrationClasses(),
    synchronize: false,
    ssl: false,
    extra: { ssl: false },
  });

  await dataSource.initialize();
  try {
    await dataSource.runMigrations({ transaction: 'all' });
  } finally {
    await dataSource.destroy();
  }
}

/** A migration class, as TypeORM recognises one. */
type MigrationClass = new () => { up: unknown; down: unknown };

/**
 * Every migration class under `src/database/migrations`.
 *
 * All exports of each file are collected, not just `default`, because the
 * migrations in this repository export a named class and no default one. Taking
 * `module.default` therefore produced `undefined` for every file, and TypeORM's
 * `buildMigrations` fails on the first one with "migrationClass is not a
 * constructor" — which is exactly what the CLI's own loader does not do: it
 * walks every exported value and keeps the ones that are classes
 * (`DirectoryExportedClassesLoader.loadFileClasses`).
 *
 * The `up`/`down` check is that same shape, narrowed. A migration file that
 * exported a helper alongside its class would otherwise have handed TypeORM
 * something to instantiate.
 */
export function loadMigrationClasses(): MigrationClass[] {
  const modules = import.meta.glob<Record<string, unknown>>(
    '../../src/database/migrations/*.ts',
    { eager: true },
  );

  return Object.values(modules)
    .flatMap((module) => Object.values(module))
    .filter(isMigrationClass);
}

const isMigrationClass = (value: unknown): value is MigrationClass =>
  typeof value === 'function' &&
  typeof (value as { prototype?: { up?: unknown; down?: unknown } }).prototype
    ?.up === 'function' &&
  typeof (value as { prototype?: { up?: unknown; down?: unknown } }).prototype
    ?.down === 'function';
