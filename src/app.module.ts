import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD, HttpAdapterHost } from '@nestjs/core';
import { ConditionalModule, ConfigModule } from '@nestjs/config';
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
  AuthModule,
  MaintenanceSchedulerModule,
  QueueModule,
  UsersModule,
} from './modules/index.js';
import {
  JwtAuthGuard,
  ManagerGuard,
  PermissionsGuard,
  RolesGuard,
} from './common/guards/index.js';
import { CacheModule, HealthModule } from './core/index.js';
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
    UsersModule,
    AuthModule,
    AdminModule,

    // Enqueues the nightly retention job. Imported here rather than inside
    // AuthModule, which already pulls in the queue for mail: the scheduler has
    // to sit above the queue in the import graph, and AuthModule does not.
    MaintenanceSchedulerModule,
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
