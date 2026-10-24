import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { AppModule } from './app.module.js';
import { ENTITIES } from './database/data-source.js';
import { MAIL_TRANSPORT } from './modules/mail/mail.service.js';
import { JOB_QUEUE } from './modules/queue/queue.tokens.js';

/**
 * The application graph resolves.
 *
 * Every other test in this repository builds a service, a module or a controller
 * in isolation. This one builds the whole `AppModule`, which is the only thing
 * that can answer "does Nest manage to wire this?", and the answer is not
 * something the type checker or a unit test can reach.
 *
 * It exists because the application **did not boot**, and nothing noticed. Six
 * separate faults sat behind the first error each time, all of them invisible to
 * the 120 unit test files:
 *
 * - `NotificationEventsModule` re-exported a provider belonging to an imported
 *   module, which Nest rejects outright.
 * - `ThrottlerModule.forRootAsync` injected a token that only `AppModule` could
 *   see. A dynamic module resolves `inject` in its own context.
 * - `SentryService` took the DSN as a constructor parameter, and Nest read that
 *   `string` as an injection token — so every deployment that set `SENTRY_DSN`
 *   failed to boot.
 * - `RetentionService` imported `DataSource` as a type, so its erased parameter
 *   reached the injector as `Object`.
 * - `RetentionScheduler` asked for a config namespace its module never registered.
 * - `MailProcessor`, `QueueHealthIndicator` and `AuthService` each injected a
 *   provider whose module was imported by the root rather than by theirs.
 *
 * A **compile-only** module override is what makes this cheap. The data source is
 * replaced with a stub, so the application graph is built and validated while
 * nothing connects to anything — no Postgres, no Redis, no Docker.
 *
 * @see docs/production.md for the rule this generalises to: a module injects what
 * it uses, and `AppModule` importing a module does not make its providers
 * available to its siblings.
 */

/**
 * The environment this file builds the application in.
 *
 * `vi.hoisted` is not a stylistic choice: an ESM import is evaluated before any
 * statement in the importing file, and `ConfigModule.forRoot` validates
 * `process.env` while `app.module.ts` is being imported. A `beforeAll` that set
 * these would be too late and the file would fail before a single test ran.
 *
 * Assigned rather than defaulted, and that is the point of the whole block. Every
 * one of these defaults to something that reaches the network or to a machine's
 * own `.env`, so a developer with `CACHE_BACKEND=redis` in theirs and a runner
 * with no `.env` at all were two different tests wearing one name. This spec has
 * to be the same test everywhere, so it states its own environment outright:
 *
 * - the two secrets `ConfigModule` refuses to boot without;
 * - `CACHE_BACKEND=memory`, because `CacheModule` deliberately turns an
 *   unreachable redis into a **failed boot** by probing the store while building
 *   it. That is right for an application and wrong here — building the graph is
 *   the whole point, and contacting a cache server is not part of it.
 *
 * Nothing here reaches a network. Postgres is stubbed, and the queue's redis
 * client connects on first command rather than at construction.
 */
vi.hoisted(() => {
  process.env['JWT_SECRET'] = 'app-module-spec-jwt-secret-value-long-enough-32';
  process.env['JWT_REFRESH_SECRET'] =
    'app-module-spec-refresh-secret-value-long-enough-32';
  process.env['NODE_ENV'] = 'test';
  process.env['CACHE_BACKEND'] = 'memory';

  // Redis points at a port nothing listens on, and refuses immediately rather
  // than queueing commands behind a reconnect.
  //
  // `ThrottlerGuard` is global, so *every* request in this file asks the rate
  // limiter to count, and the limiter's storage is a redis client. With the
  // offline queue on, an unreachable server holds that request open until the
  // test times out, which looks like a routing failure and is not one.
  // `REDIS_DISABLE_OFFLINE_QUEUE=true` is also what a production deployment
  // should set, for the same reason.
  process.env['REDIS_URL'] = 'redis://127.0.0.1:1';
  process.env['REDIS_DISABLE_OFFLINE_QUEUE'] = 'true';
  // The first command on an unreachable server waits for the connect to time
  // out, and the default is five seconds — exactly a test's budget. A quarter of
  // a second is enough to prove "nothing is listening here", which is the only
  // thing this file needs to know.
  process.env['REDIS_CONNECT_TIMEOUT'] = '250';
  process.env['QUEUE_ENABLED'] = 'false';
});

describe('the application module', () => {
  it('builds', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(getDataSourceToken())
      .useValue(stubDataSource())
      .compile();

    await moduleRef.close();
  });

  it('serves the routes where a client actually looks for them', async () => {
    const app = await bootedApp();

    try {
      // The prefix and the URI versioning come from `configureApp`, the same
      // function `main.ts` runs. They used to live inline in `main.ts`, so a test
      // that booted the application without them found `/health` on the bare
      // path — and the only symptom was a suite reaching a 404 while passing
      // every assertion about how the response would look.
      // `/auth/me` rather than `/health`, because `health` runs Terminus against
      // the stubbed data source and a check with nothing behind it waits rather
      // than answering. An unauthenticated caller getting a 401 proves the route
      // is mounted *and* that the guard chain is running, which a health check
      // would not.
      const prefixed = await request(app.getHttpServer()).get(
        '/api/v1/auth/me',
      );
      const bare = await request(app.getHttpServer()).get('/auth/me');

      expect(prefixed.status).toBe(401);
      // The route exists once. A second copy at the bare path would mean a client
      // could reach it both ways, which is not what ships.
      expect(bare.status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('provides the queue and the transport the way the routes ask for them', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(getDataSourceToken())
      .useValue(stubDataSource())
      .compile();

    // Spot checks rather than an inventory. `compile()` has already instantiated
    // every provider and controller, so these confirm the tokens a route injects
    // by name are the same objects the container holds — the class of mistake
    // where two copies of a token string exist because one was imported through a
    // barrel and one through its file.
    const queue = moduleRef.get<{ driver: string }>(JOB_QUEUE);
    const transport = moduleRef.get<{ name: string }>(MAIL_TRANSPORT);

    expect(['bullmq', 'in-process']).toContain(queue.driver);
    expect(typeof transport.name).toBe('string');

    await moduleRef.close();
  });
});

/** A compiled, configured application with nothing behind it. */
async function bootedApp() {
  const { configureApp } = await import('./bootstrap.js');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(getDataSourceToken())
    .useValue(stubDataSource())
    .compile();

  const app = moduleRef.createNestApplication(new FastifyAdapter());
  configureApp(app);
  await app.init();
  await (
    app.getHttpAdapter().getInstance() as { ready: () => Promise<unknown> }
  ).ready();

  return app;
}

/**
 * The smallest thing `TypeOrmModule` needs from a data source at wiring time.
 *
 * `entityMetadatas` is the part that is not optional: `createTypeOrmProviders`
 * searches it for the entity a repository is being created for, and an absent
 * property is a `TypeError` during compile rather than a connection attempt. One
 * metadata per entity this application registers, which is enough to keep the
 * repository factories on the branch that `getRepository` returns a real thing.
 *
 * Nothing here connects, reads or writes. The repositories are constructed from
 * it and the application never reaches one during compile.
 */
function stubDataSource(): DataSource {
  const entityMetadatas = ENTITIES.map((target) => ({
    target,
    treeType: undefined,
  }));

  return {
    isInitialized: true,
    entityMetadatas,
    options: { type: 'postgres' },
    getRepository: () => ({}),
    getMongoRepository: () => ({}),
    getTreeRepository: () => ({}),
    createEntityManager: () => ({}),
    createQueryRunner: () => ({}),
    getMetadata: () => ({}),
    destroy: async () => undefined,
    initialize: async () => undefined,
  } as unknown as DataSource;
}
