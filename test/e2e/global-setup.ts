import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DataSource } from 'typeorm';
import {
  GenericContainer,
  Wait,
  getContainerRuntimeClient,
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
 * Explicit opt-out. `E2E_NO_CONTAINERS=1 npm run test:e2e`.
 *
 * Kept as a flag rather than only a probe because a probe cannot distinguish
 * "no runtime installed" from "the daemon is slow to answer", and guessing wrong
 * in the second direction turns a real run into a silent skip.
 */
const containersDisabled = (): boolean => process.env.E2E_NO_CONTAINERS === '1';

/**
 * True when a container runtime can actually be reached.
 *
 * This exists because the alternative is the error everybody meets first:
 * `Could not find a working container runtime strategy`, which says what
 * testcontainers looked for and nothing about what to do next. On a machine with
 * no Docker at all — a common state on a laptop that only ever runs the unit
 * suite — that is the whole output of `npm run test:e2e`.
 */
async function containerRuntimeAvailable(): Promise<boolean> {
  try {
    // Resolving the client is itself the check: it throws when no runtime
    // answers, which is where `Could not find a working container runtime
    // strategy` came from.
    const client: { info?: unknown } = await getContainerRuntimeClient();

    // The extra call catches the other half — Docker installed and stopped, where
    // a client resolves but nothing answers it. Typed loosely because `info` is a
    // function on the docker client and a plain value on some of the others.
    if (typeof client.info === 'function') {
      await (client.info as () => Promise<unknown>)();
    }

    return true;
  } catch {
    return false;
  }
}

export const NO_RUNTIME_GUIDANCE = [
  'npm run test:e2e needs a container runtime and none answered.',
  '',
  '  1. Start one. Docker Desktop, colima (`colima start`) or podman all work;',
  '     `docker info` is the check.',
  '  2. Or point the suite at a stack you already have:',
  '       docker compose up -d postgres valkey',
  '       E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nestjs_boiler_plate \\',
  '       E2E_REDIS_URL=redis://localhost:6379/1 npm run test:e2e',
  '  3. Or skip it, which runs nothing and reports nothing as passing:',
  '       E2E_NO_CONTAINERS=1 npm run test:e2e',
].join('\n');

export interface InfraInputs {
  externalDatabase?: string;
  externalRedis?: string;
  runtimeAvailable: boolean;
  ci: boolean;
}

export type InfraPlan =
  /** Nothing to do: the flags already said not to. */
  | { action: 'skip'; reason: 'disabled' }
  /** No runtime and nothing supplied: fail on CI, skip anywhere else. */
  | { action: 'skip'; reason: 'no-runtime'; guidance: string }
  | { action: 'fail'; reason: 'no-runtime'; guidance: string }
  /** Run, starting whatever was not supplied. */
  | { action: 'run' };

/**
 * What to do about infrastructure, given what is available.
 *
 * A pure function so the matrix is testable without a runtime. It matters
 * because the two branches differ only by `CI`, and that difference is the whole
 * point of the change: the same machine with the same missing Docker skips
 * locally — where the unit suite is the real gate — and fails on CI, where a
 * skip would report success on a suite that never ran.
 */
export function planInfra(inputs: InfraInputs): InfraPlan {
  const { externalDatabase, externalRedis, runtimeAvailable, ci } = inputs;

  if (containersDisabled()) {
    return { action: 'skip', reason: 'disabled' };
  }

  const needsContainer = !externalDatabase || !externalRedis;

  if (needsContainer && !runtimeAvailable) {
    return ci
      ? { action: 'fail', reason: 'no-runtime', guidance: NO_RUNTIME_GUIDANCE }
      : { action: 'skip', reason: 'no-runtime', guidance: NO_RUNTIME_GUIDANCE };
  }

  return { action: 'run' };
}

/**
 * The isolation mode this run proves.
 *
 * `off` is the single-tenant application. `on` resolves a tenant per request
 * and carries it through the context, cache and queue. `rls` additionally
 * connects as the non-superuser role, so the policies are the thing that
 * catches a query that forgot the scope — which is the mode that earns its
 * keep.
 */
export type TenancyMode = 'off' | 'on' | 'rls';

export function tenancyMode(): TenancyMode {
  const configured = process.env.E2E_TENANCY_MODE ?? 'off';

  if (configured !== 'off' && configured !== 'on' && configured !== 'rls') {
    throw new Error(
      `E2E_TENANCY_MODE must be one of off, on, rls (got "${configured}")`,
    );
  }

  return configured;
}

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
  // An externally supplied address wins. It is what makes the suite runnable on a
  // laptop that already has `docker compose up`, without paying for two more
  // containers on top — and the reason a machine with no Docker at all can still
  // run it, which is a configuration rather than a workaround.
  const externalDatabase = process.env.E2E_DATABASE_URL;
  const externalRedis = process.env.E2E_REDIS_URL;

  const needsContainer = !externalDatabase || !externalRedis;

  const plan = planInfra({
    externalDatabase,
    externalRedis,
    runtimeAvailable: needsContainer
      ? await containerRuntimeAvailable()
      : false,
    ci: Boolean(process.env.CI),
  });

  if (plan.action === 'fail') {
    throw new Error(plan.guidance);
  }

  if (plan.action === 'skip') {
    // The file is removed as well as not written, and that is the point.
    //
    // `e2eEnabled()` is a check for this file, so a stale one left by an earlier
    // run would switch the suite back on while the setup is explicitly skipping
    // it: the specs would try to reach a database nobody started, every file
    // would fail, and the output would say the tests were skipped while also
    // saying the files failed. The file is the switch, so removing it is the only
    // way "skip" means skip.
    rmSync(ENV_FILE, { force: true });

    console.warn(
      plan.reason === 'disabled'
        ? '[e2e] E2E_NO_CONTAINERS=1, every spec is skipped.'
        : `[e2e] ${plan.guidance}\n[e2e] Every spec is skipped. Run \`npm test\` for the unit suite.`,
    );
    return;
  }

  const databaseUrl = externalDatabase ?? (await startPostgres());
  const redisUrl = externalRedis ?? (await startRedis());

  await migrate(databaseUrl);

  const mode = tenancyMode();
  const appDatabaseUrl =
    mode === 'rls' ? await connectAsAppUser(databaseUrl) : databaseUrl;

  mkdirSync(HERE, { recursive: true });
  writeFileSync(
    ENV_FILE,
    JSON.stringify(
      {
        ...TEST_ENV,
        DATABASE_URL: appDatabaseUrl,
        // The owner connection the suite uses to reset the database, seed every
        // tenant and read rows across tenants. The application itself never gets
        // this url: in `rls` mode it connects as `app_user`.
        ADMIN_DATABASE_URL: databaseUrl,
        DATABASE_SSL: 'false',
        MULTI_TENANT: mode === 'off' ? 'false' : 'true',
        DATABASE_RLS: mode === 'rls' ? 'true' : 'false',
        TENANT_HEADER: 'x-tenant-id',
        // The tenant every existing spec means. The harness attaches it to every
        // request when multi-tenancy is on, so a spec that is not about tenancy
        // does not have to know about it.
        E2E_TENANT_SLUG: 'default',
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
    // Waiting for "database system is ready to accept connections" looks right
    // and is not: on a fresh volume the entrypoint runs a throwaway server
    // during initdb which logs exactly that line, then shuts it down again. The
    // wait resolves on that temporary server, `start()` returns, and the first
    // real connection is reset while the final server is still coming up —
    // which surfaces as a bare `read ECONNRESET` from `migrate` with nothing in
    // the suite output about containers at all.
    //
    // `PostgreSQL init process complete; ready for start up` is printed only
    // once initdb has finished and the entrypoint is about to start the real
    // server. `migrate` then retries the connection regardless, because the
    // log line lands slightly before postgres binds its port.
    .withWaitStrategy(
      Wait.forLogMessage(
        /PostgreSQL init process complete; ready for start up/i,
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
 * Gives the RLS role a password and returns the url the application uses.
 *
 * The migration creates `app_user` without one on purpose: credentials are the
 * deployment's, not a migration's. A test container has no deployment to set
 * them, so the suite does, and then points the application at that role.
 *
 * The owner url is kept separately so the harness can seed and truncate: the
 * whole point of this mode is that the application cannot.
 */
async function connectAsAppUser(databaseUrl: string): Promise<string> {
  const password = 'e2e-app-user-password';
  const dataSource = new DataSource({
    type: 'postgres',
    url: databaseUrl,
    ssl: false,
    extra: { ssl: false },
  });

  await dataSource.initialize();

  try {
    await dataSource.query(`ALTER ROLE app_user WITH PASSWORD '${password}'`);
  } finally {
    await dataSource.destroy();
  }

  const url = new URL(databaseUrl);
  url.username = 'app_user';
  url.password = password;

  return url.toString();
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

  await connectWithRetry(dataSource);
  try {
    // The initial migration declares its primary keys with
    // `DEFAULT uuid_generate_v4()`, which is the `uuid-ossp` extension — and no
    // migration creates it, because the database this repository is developed
    // against already has it. A fresh container does not: the official image
    // ships the extension's files without enabling it.
    //
    // Created here rather than in a migration because that dependency predates
    // this suite, and a migration that already ran on somebody's database cannot
    // be edited without a checksum story nobody wants. `IF NOT EXISTS` means it
    // is a no-op everywhere it is already present.
    await dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

    await dataSource.runMigrations({ transaction: 'all' });
  } finally {
    await dataSource.destroy();
  }
}

/** A migration class, as TypeORM recognises one. */
type MigrationClass = new () => { up: unknown; down: unknown };

/**
 * Connects, retrying while the server refuses.
 *
 * Postgres accepting the tcp connection is not the same as accepting a query:
 * the entrypoint starts the real server after the log line the wait strategy
 * watches for, so there is a short window where a connection is established and
 * then dropped. A single `initialize()` either lands in that window or does not,
 * which is why this read as an intermittent failure.
 *
 * Only connection failures are retried, and the deadline is long enough to cover
 * a cold image on a loaded machine but short enough that a genuinely wrong url
 * still fails the run rather than appearing to hang.
 */
async function connectWithRetry(dataSource: DataSource): Promise<void> {
  const deadline = Date.now() + 60_000;

  for (;;) {
    try {
      await dataSource.initialize();
      return;
    } catch (error) {
      if (Date.now() >= deadline || !isConnectionFailure(error)) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/**
 * Whether an error is the connection being refused or dropped, rather than
 * something wrong with the configuration.
 *
 * `ECONNRESET` is the one this suite actually hit, and it is also the one a
 * proxy in front of the database produces for a bad password — so the message is
 * checked too, which distinguishes "server closed the socket" from "server
 * rejected the credentials". Everything else, a missing extension or a failed
 * migration, fails immediately.
 */
function isConnectionFailure(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;

  if (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT'
  ) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);

  return /econnreset|econnrefused|etimedout|connection terminated|socket hang up/i.test(
    message,
  );
}

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
