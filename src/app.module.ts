import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD, HttpAdapterHost } from '@nestjs/core';
import { ConditionalModule, ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { createObserveModule } from '@nestjs/observe';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  appConfig,
  cacheConfig,
  corsConfig,
  databaseConfig,
  jwtAccessTokenConfig,
  jwtRefreshTokenConfig,
  observeConfig,
  redisConfig,
  securityConfig,
  swaggerConfig,
  throttlerConfig,
  throttlerModuleConfig,
  twoFactorConfig,
  validateEnvironment,
} from './configs/index.js';
import {
  AdminModule,
  AuditModule,
  AuthModule,
  MaintenanceSchedulerModule,
  NotificationEventsModule,
  QueueModule,
  UsersModule,
} from './modules/index.js';
import {
  IdempotencyGuard,
  JwtAuthGuard,
  ManagerGuard,
  PermissionsGuard,
  RequireVerifiedEmailGuard,
  RolesGuard,
} from './common/guards/index.js';
import {
  CacheModule,
  HealthModule,
  HttpTracingInterceptor,
  MetricsModule,
  SentryModule,
  TracingModule,
} from './core/index.js';
import {
  catchAllRoute,
  RequestIdMiddleware,
} from './common/middlewares/index.js';
import { THROTTLER_STORAGE } from './modules/queue/throttler/redis-throttler.storage.js';
import { AppService } from './app.service.js';
import { AppController } from './app.controller.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
      load: [
        appConfig,
        cacheConfig,
        corsConfig,
        databaseConfig,
        jwtAccessTokenConfig,
        jwtRefreshTokenConfig,
        observeConfig,
        redisConfig,
        securityConfig,
        swaggerConfig,
        throttlerConfig,
        twoFactorConfig,
      ],
    }),
    // Distributed tracing, auto-correlated logs, request/job metrics, error
    // telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com
    ConditionalModule.registerWhen(
      ObserveModule.forRootAsync(observeConfig.asProvider()),
      (env: NodeJS.ProcessEnv) =>
        !!env['OBSERVE_APP_KEY'] &&
        !!env['OBSERVE_APP_SECRET'] &&
        !!env['OBSERVE_SERVICE_ID'],
    ),
    TypeOrmModule.forRootAsync(databaseConfig.asProvider()),

    /**
     * Imported for `THROTTLER_STORAGE` and its redis client, not for the queue
     * jobs: nothing here enqueues, but the rate limiter has to count in the same
     * place across replicas or the limit is one per process.
     */
    QueueModule,
    ThrottlerModule.forRootAsync({
      /**
       * `QueueModule` again, and deliberately.
       *
       * The storage provider lives there, and a dynamic module resolves its
       * `inject` list in *its own* context — not in the context of the file that
       * registered it. Importing `QueueModule` at the root of `AppModule` makes
       * the provider available to `AppModule`, which is a different question from
       * whether it is available to `ThrottlerModule`.
       *
       * Omitting it reads fine: the type is a `string`, so `inject` type-checks,
       * and every unit test passes because none of them builds the application.
       * It fails at boot with "Nest can't resolve dependencies of the
       * THROTTLER:MODULE_OPTIONS (?)".
       */
      imports: [QueueModule],
      inject: [THROTTLER_STORAGE],
      useFactory: throttlerModuleConfig,
    }),

    /**
     * Scheduled work, registered once for the whole application.
     *
     * `forRoot` may only be called in one place, so this belongs at the root
     * rather than inside whichever module happens to schedule something first.
     * Keeping it here means the next cron is a provider in its own module and no
     * change to this file at all.
     */
    ScheduleModule.forRoot(),

    CacheModule,
    HealthModule,
    // Owns nothing but the optional prom-client registry, and the `/metrics`
    // route. Imported at the root because every module that records a metric
    // injects the service from here rather than from each other.
    MetricsModule,

    /**
     * OpenTelemetry spans.
     *
     * `@opentelemetry/api` and nothing else — no SDK, no exporter. Install one and
     * the spans start appearing with no change here; leave it out and every method
     * is a no-op. That is what makes the integration honest: what is missing is a
     * collector to send them to, and that is a deployment's business rather than
     * something this boilerplate should choose for whoever clones it.
     */
    TracingModule,

    /**
     * Sentry error reporting.
     *
     * A leaf in the graph — it imports nothing, because the SDK is resolved
     * through `loadOptional` — so it sits at the root and everything that wants
     * to report an error can get it without importing it from here.
     */
    SentryModule,
    UsersModule,
    AuthModule,
    AdminModule,

    /**
     * The audit trail.
     *
     * Here rather than inside one of the modules that writes to it, because it is
     * imported by all of them and a module that imported its own audit writer back
     * would be a cycle. It imports nothing but TypeORM, so sitting at the root costs
     * nothing.
     */
    AuditModule,

    // Enqueues the nightly retention job. Imported here rather than inside
    // AuthModule, which already pulls in the queue for mail: the scheduler has to
    // sit above the queue in the import graph, and AuthModule does not.
    MaintenanceSchedulerModule,

    /**
     * The emit side of notifications, and the preferences routes.
     *
     * At the root for the same reason as the scheduler: it imports the queue, so it
     * has to sit above it. AuthModule and UsersModule import it for the events they
     * raise, which is what makes "a registration notifies every enabled channel" an
     * import rather than a global.
     */
    NotificationEventsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ManagerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
    {
      // After the permissions guard, so a caller without the permission is told
      // that rather than being asked to verify an address first. A gate that runs
      // earlier turns "you are not allowed this" into "confirm your email", which
      // is advice that does not help.
      provide: APP_GUARD,
      useClass: RequireVerifiedEmailGuard,
    },
    {
      // First, so everything below it is inside the request's span. Guard order is
      // the order they run in, and a trace that starts after the authentication
      // work has already happened is a trace missing its slowest and most
      // interesting part.
      provide: APP_INTERCEPTOR,
      useClass: HttpTracingInterceptor,
    },
    {
      // Last in the chain. A duplicate key is only meaningful once the caller is
      // known and allowed: claiming a key for a request that was going to be
      // refused would leave a key in redis that the real caller then collides with,
      // and answering 409 to an unauthenticated request would leak that the key is
      // in use.
      provide: APP_GUARD,
      useClass: IdempotencyGuard,
    },
    {
      // Registered last so a blocked request is counted before anything else
      // spends time on it, and skipped for probes that carry no identity.
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule implements NestModule {
  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  configure(consumer: MiddlewareConsumer): void {
    // Every route, so even a request rejected by a guard carries an id that can be
    // quoted in a bug report. The pattern depends on the platform, see
    // catchAllRoute.
    consumer
      .apply(RequestIdMiddleware)
      .forRoutes(catchAllRoute(this.httpAdapterHost.httpAdapter));
  }
}
