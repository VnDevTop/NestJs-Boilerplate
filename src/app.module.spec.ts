import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { describe, expect, it } from 'vitest';

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
describe('the application module', () => {
  it('builds', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(getDataSourceToken())
      .useValue(stubDataSource())
      .compile();

    await moduleRef.close();
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
