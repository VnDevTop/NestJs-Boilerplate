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

/** Where the application listens, mirrored by `API_PREFIX`/`API_VERSION`. */
export const API_ROOT = '/api/v1';

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
  const { getDataSourceToken } = await import('@nestjs/typeorm');

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();

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

/** Clears the cache and redis namespaces between specs. */
export async function resetRedis(): Promise<void> {
  const { createClient } = await import('redis');

  const client = createClient({
    url: process.env.CACHE_URL,
    socket: { connectTimeout: 5_000 },
  });

  await client.connect();

  try {
    for (const pattern of [
      `${process.env.CACHE_KEY_PREFIX}:*`,
      `${process.env.REDIS_KEY_PREFIX}:*`,
    ]) {
      // A scan rather than `keys`, so a large namespace cannot block the server
      // the way a `keys` does. The suite is small, but the habit is the point.
      for await (const key of client.scanIterator({
        MATCH: pattern,
        COUNT: 500,
      })) {
        await client.del(key);
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

/** Registers a user over HTTP and returns their access token. */
export async function registerAndLogin(
  app: INestApplication,
  email: string,
): Promise<string> {
  const password = 'E2e-password-1-Strong';

  await http(app)
    .post(`${API_ROOT}/auth/register`)
    .send({ email, password, firstName: 'E2e', lastName: 'User' })
    .expect(201);

  const response = await http(app)
    .post(`${API_ROOT}/auth/login`)
    .send({ email, password })
    .expect(200);

  return response.body.accessToken as string;
}

export const http = (app: INestApplication) => request(app.getHttpServer());
