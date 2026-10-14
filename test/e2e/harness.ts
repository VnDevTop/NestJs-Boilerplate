import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { Test } from '@nestjs/testing';
import request from 'supertest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(HERE, '..', '.e2e-env.json');

/**
 * The e2e harness: environment, application boot and database cleanup.
 *
 * The one rule everything else follows from is that `AppModule` reads
 * `process.env` while it is being imported, and `ConfigModule` caches the
 * result for the life of the process. A harness that imported it at the top of
 * the file would therefore boot the application against whatever `.env` the
 * developer happens to have. Every boot here goes through a dynamic import
 * after the environment is in place, which is why the specs import `AppModule`
 * through `boot()` rather than directly.
 */

/**
 * Where the application listens.
 *
 * A constant rather than a literal in each spec, because it is a *fact about the
 * running application* and `boot()` reads it from the same config the routes were
 * registered with. A spec that hard-codes `/api/v1` passes on a deployment
 * configured otherwise, which is the same way the whole suite was testing the
 * wrong application.
 */
export let API_ROOT = '/api/v1';

export type BootedApp = {
  app: INestApplication;
  dataSource: DataSource;
};

/**
 * Whether the e2e suite can run at all.
 *
 * The specs use it to skip rather than to fail, because a machine without
 * docker is a normal thing to work on and the unit suite is the real gate. CI
 * sets no flag, so an e2e job that cannot start its containers fails loudly
 * instead of quietly reporting success on nothing.
 */
export function e2eEnabled(): boolean {
  return existsSync(ENV_FILE);
}

/**
 * Copies the generated environment into `process.env`.
 *
 * Not a merge that skips existing keys. A developer's shell may already hold a
 * `DATABASE_URL`, and silently keeping it is how a suite ends up deleting rows
 * out of a database somebody cares about.
 */
export function applyE2eEnvironment(): void {
  if (!existsSync(ENV_FILE)) {
    throw new Error(
      `Missing ${ENV_FILE}. The e2e environment is written by test/e2e/global-setup.ts.`,
    );
  }

  for (const [key, value] of Object.entries(
    JSON.parse(readFileSync(ENV_FILE, 'utf8')) as Record<string, string>,
  )) {
    process.env[key] = value;
  }
}

/**
 * Boots the whole application against the test containers.
 *
 * `Test.createTestingModule` rather than the compiled `AppModule` directly, so
 * the app is the same graph production runs instead of a hand-assembled subset
 * that would miss a provider wiring bug.
 */
export async function boot(): Promise<BootedApp> {
  applyE2eEnvironment();

  // Imported after the environment is set, because the config namespaces read
  // `process.env` at module scope.
  const { AppModule } = await import('../../src/app.module.js');
  const { configureApp, apiRoot } = await import('../../src/bootstrap.js');
  const { getDataSourceToken } = await import('@nestjs/typeorm');

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();

  // The same wiring `main.ts` applies. Without it the global prefix and the URI
  // versioning never happen, `/health` is not the route a client calls, and no
  // response is wrapped — so every URL and every body in this suite would be
  // describing an application nobody runs.
  configureApp(app);

  await app.init();

  // A live binding, so every spec that reads `API_ROOT` inside a test body gets
  // the prefix this run actually mounted rather than the one someone typed.
  API_ROOT = apiRoot(app);

  return { app, dataSource: app.get(getDataSourceToken()) };
}

/**
 * Truncates every table, leaving the schema in place.
 *
 * `TRUNCATE ... CASCADE` rather than deleting row by row: a delete leaves the
 * sequences where they were, so ids would keep climbing across specs and any
 * assertion comparing two ids would be comparing a coincidence.
 */
export async function resetDatabase(
  dataSource: BootedApp['dataSource'],
): Promise<void> {
  const rows = await dataSource.query<{ tablename: string }[]>(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = current_schema()
      AND tablename <> 'migrations'
  `);

  if (rows.length === 0) {
    return;
  }

  const quoted = rows.map(({ tablename }) => `"${tablename}"`).join(', ');
  await dataSource.query(`TRUNCATE ${quoted} RESTART IDENTITY CASCADE`);
}

/**
 * Every key the suite's own runs can leave behind.
 *
 * **The namespace prefix is part of every one of these.** `RedisClientService`
 * applies `REDIS_KEY_PREFIX` itself (`redis-client.service.ts`, `key()`), so the
 * counters on the wire are `e2e:redis:throttle:login-ip:<hash>` and never the bare
 * `throttle:login-ip:<hash>`. The patterns below listed the bare names, matched
 * nothing, and cleared nothing — while still passing every run, because a scan
 * that finds no keys is not an error.
 *
 * That is how the login throttle survived `cleanState` and the failure surfaced
 * as a 429 in whichever file happened to run after the one that spent the bucket:
 *
 *     Error: login fresh@example.test: expected 200, got 429
 *
 * A login that any client could make was refused for requests no client in that
 * file had sent.
 *
 * The lockout keys are the second half of it, and they were never in the list at
 * all — a different prefix written by a different module.
 */
const redisKeyPatterns = (): string[] => {
  const namespace = process.env.REDIS_KEY_PREFIX;

  return [
    `${process.env.CACHE_KEY_PREFIX}:*`,
    // Deduplication markers, idempotency claims, throttle counters and the
    // dead-letter list all live in the queue namespace.
    `${namespace}:*`,
    // Login lockout counters. Not in the queue namespace and not the cache's —
    // written by `LoginLockoutService` under its own prefix — so the
    // `${namespace}:*` above does not reach them either. These lock the account
    // itself, so a leftover one fails the next file's login with a 401 or 429
    // rather than anything a reader would connect to a route.
    'lockout:login*',
    // Session revocations, written straight to redis rather than through the
    // cache, because there is no column to re-read them from.
    'token:revoked:*',
  ];
};

/**
 * Clears every redis namespace the suite wrote to.
 *
 * **Every** database the application is configured with, selected and cleared in
 * turn. This loop previously ran `select()` for each url and then fell through to
 * the scans, leaving the client on the *last* database and clearing only that one.
 */
export async function resetRedis(): Promise<void> {
  const { createClient } = await import('redis');

  const urls = [
    process.env.CACHE_URL,
    process.env.REDIS_URL,
    process.env.QUEUE_REDIS_URL,
  ].filter((url): url is string => Boolean(url));

  if (urls.length === 0) {
    return;
  }

  const client = createClient({
    url: urls[0],
    socket: { connectTimeout: 5_000 },
  });

  await client.connect();

  try {
    const patterns = redisKeyPatterns();

    for (const url of urls) {
      await client.select(Number(new URL(url).pathname.slice(1) || 0));

      for (const pattern of patterns) {
        // A scan rather than `keys`, so a large namespace cannot block the server
        // the way a `keys` does. The suite is small, but the habit is the point.
        //
        // The iterator yields **batches**, not single keys, and each batch is an
        // array. Passing one straight to `del` is `DEL <array>`, which the server
        // answers with "ERR wrong number of arguments" — so the whole reset fails
        // and every spec after it inherits the previous file's rows.
        for await (const keys of client.scanIterator({
          MATCH: pattern,
          COUNT: 500,
        })) {
          const batch = Array.isArray(keys) ? keys : [keys];

          if (batch.length > 0) {
            await client.del(batch);
          }
        }
      }
    }
  } finally {
    await client.quit();
  }
}

/** A fresh set of tables and an empty cache, in the order that is safe. */
export async function cleanState({ dataSource }: BootedApp): Promise<void> {
  await resetDatabase(dataSource);
  await resetRedis();
}

/**
 * Creates the roles, permissions and the first administrator.
 *
 * The application's own seeders, called directly, rather than a hand-written
 * insert. A fixture that wrote its own admin row would test a route against a
 * user the seed could not have produced, and the first thing to break would be a
 * password hash or a role enum that moved.
 */
export async function seedAdmin(
  dataSource: BootedApp['dataSource'],
): Promise<void> {
  const { PermissionSeeder } =
    await import('../../src/database/seeds/permission.seeder.js');
  const { AdminSeeder } =
    await import('../../src/database/seeds/admin.seeder.js');

  await new PermissionSeeder().run(dataSource);
  await new AdminSeeder().run(dataSource);
}

/**
 * Promotes the seeded administrator to super administrator.
 *
 * The seeder creates a plain admin, and a plain admin deliberately holds neither
 * `RoleWrite` nor `MaintenanceRun` — an administrator who could rewrite roles
 * could grant themselves another administrator's. The routes the e2e suite
 * exercises need those two permissions, so the fixture promotes rather than
 * re-seeding with a different role, which would stop testing the seeder.
 */
export async function promoteToSuperAdmin(
  dataSource: BootedApp['dataSource'],
  email: string,
): Promise<void> {
  const { Role } = await import('../../src/common/enums/index.js');

  await dataSource.query('UPDATE users SET role = $1 WHERE email = $2', [
    Role.SuperAdmin,
    email.toLowerCase(),
  ]);
}

/** Registers a user over HTTP and returns their access token. */
export async function registerAndLogin(
  app: INestApplication,
  email: string,
): Promise<string> {
  const password = 'E2e-password-1-Strong';

  await expectStatus(
    http(app)
      .post(`${API_ROOT}/auth/register`)
      .send({ email, password, firstName: 'E2e', lastName: 'User' }),
    201,
    `register ${email}`,
  );

  const response = await expectStatus(
    http(app).post(`${API_ROOT}/auth/login`).send({ email, password }),
    200,
    `login ${email}`,
  );

  return response.body.data.accessToken as string;
}

/**
 * Asserts a status with the response body attached.
 *
 * supertest's `.expect(code)` throws a one-line error carrying the status and
 * nothing else, and in a suite where a wrong status is the symptom — not the
 * cause — that turns every failure into another round trip. This prints the body
 * the application actually sent.
 */
export async function expectStatus(
  pending: request.Test,
  expected: number,
  what: string,
): Promise<request.Response> {
  const response = await pending;

  if (response.status !== expected) {
    throw new Error(
      `${what}: expected ${expected}, got ${response.status}\n` +
        `  body: ${JSON.stringify(response.body).slice(0, 800)}\n` +
        `  idempotency-key: ${response.request?.getHeader?.('Idempotency-Key') ?? 'none'}`,
    );
  }

  return response;
}

/**
 * Polls until a predicate holds, or fails with what it last saw.
 *
 * Several things the application does are legitimately not finished when the
 * http response returns: mail is enqueued and processed in the worker, and the
 * in-process dispatcher resolves its enqueue before running the job. An
 * assertion that reads a `mail_logs` row straight after a register is a race
 * that passes on a fast machine and fails in CI.
 *
 * Polling rather than a fixed sleep, so the suite is neither slow nor flaky: it
 * waits exactly as long as the work took.
 */
export async function waitFor(
  predicate: () => Promise<boolean>,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    description?: string;
  } = {},
): Promise<void> {
  const {
    timeoutMs = 10_000,
    intervalMs = 50,
    description = 'condition',
  } = options;

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description}. ` +
      'The application did not do it, rather than being slow.',
  );
}

/** The templates recorded in `mail_logs`, in order. */
export async function mailTemplates(dataSource: DataSource): Promise<string[]> {
  const rows = await dataSource.query<{ template: string }[]>(
    'SELECT template FROM mail_logs ORDER BY "createdAt"',
  );

  return rows.map((row) => row.template);
}

/**
 * Every mutating route in this application requires an `Idempotency-Key`, and the
 * application refuses the request without one — correct behaviour, and a fact a
 * test has to respect the way a client does.
 *
 * The header is attached here rather than in each spec, because forgetting it in
 * one place produces a 400 that reads as a broken route. Each request gets a
 * distinct value, because reusing a key is the *other* thing idempotency is for: a
 * spec that retried on purpose would otherwise be replaying an answer the guard is
 * designed to hand back.
 */
const SAFE_METHODS = new Set(['get', 'head', 'options']);

const VERBS = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
] as const;

type Verb = (typeof VERBS)[number];

/** supertest's verb methods, which is the whole of what this harness uses. */
type RequestMethods = Record<Verb, (url: string) => request.Test>;

/** The shape the specs use: the verbs, and nothing else. */
export type HttpAgent = Record<Verb, (url: string) => request.Test>;

/**
 * A uuid per request, not a counter.
 *
 * A counter looked safe and was not: vitest gives each test file a fresh module
 * registry, so the counter restarted at 1 in every file and every file's second
 * `POST /auth/register` sent `e2e-2` — the same key, to the same path, as the
 * previous file's. The idempotency guard then replayed the earlier file's stored
 * response, so a registration was reported as created when the row had never been
 * written and the follow-up sign-in answered 401 for an address that did not
 * exist.
 *
 * A uuid cannot collide across files, processes or runs, which is exactly the
 * property the header is asking for.
 */
const newIdempotencyKey = (): string => `e2e-${randomUUID()}`;

/**
 * Wraps supertest's agent so every mutating request carries a key.
 *
 * **supertest's agent is an object, not a function.** `request(server)` returns
 * something you call as `agent.post(url)`, `agent.get(url)` — calling the agent
 * itself is `TypeError: agent is not a function`. That is what this function did
 * for one CI run, because the unit test beside it used a *callable* fake and so
 * agreed with it: the fake had modelled the bug away instead of catching it.
 *
 * `createHttp` therefore takes the agent and returns a new object whose verbs
 * delegate to it, which is what `http.spec.ts` now exercises with a fake that is
 * an object for the same reason.
 */
export function createHttp(agent: RequestMethods): HttpAgent {
  const call = (method: Verb, url: string): request.Test => {
    const built = agent[method](url);

    const withKey = SAFE_METHODS.has(method)
      ? built
      : built.set('Idempotency-Key', newIdempotencyKey());

    // The body of a failed response, which supertest's `.expect()` throws away.
    // Without this a failing e2e run reports a status code and nothing else, and
    // the body is the only thing that says which validation rule fired.
    withKey.on('response', (res: { status: number; body: unknown }) => {
      if (res.status >= 400) {
        console.error(
          `[e2e] ${method.toUpperCase()} ${url} -> ${res.status} ${JSON.stringify(res.body).slice(0, 500)}`,
        );
      }
    });

    return withKey;
  };

  return Object.fromEntries(
    VERBS.map((verb) => [verb, (url: string) => call(verb, url)]),
  ) as HttpAgent;
}

export const http = (app: INestApplication): HttpAgent =>
  createHttp(request(app.getHttpServer()));
