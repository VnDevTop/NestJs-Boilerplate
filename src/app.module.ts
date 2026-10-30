import { Module } from '@nestjs/common';
import { ConfigModule, ConditionalModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createObserveModule } from '@nestjs/observe';
import { TerminusModule } from '@nestjs/terminus';
import { CacheModule } from '@nestjs/cache-manager';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { MailerModule } from '@nestjs-modules/mailer';
import { I18nModule as NestI18nModule } from 'nestjs-i18n';
import { HttpModule as NestHttpModule } from '@nestjs/axios';
import { ResilienceModule } from '@nestjs/resilience';
import { IdempotencyModule } from '@nestjs/idempotency';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { HealthController } from './health.controller.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { UsersModule } from './modules/users/index.js';
import { ResilientHttpService } from './common/utils/resilient-http.service.js';
import {
  appConfig,
  cacheConfig,
  corsConfig,
  databaseConfig,
  httpConfig,
  idempotencyConfig,
  i18nConfig,
  mailConfig,
  observeConfig,
  queueConfig,
  resilienceConfig,
  swaggerConfig,
  throttleConfig,
  validateEnv,
} from './config/index.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        cacheConfig,
        corsConfig,
        databaseConfig,
        httpConfig,
        i18nConfig,
        mailConfig,
        observeConfig,
        queueConfig,
        swaggerConfig,
        throttleConfig,
      ],
      validate: validateEnv,
      envFilePath: ['.env', '.env.local'],
    }),
    CacheModule.registerAsync(cacheConfig.asProvider()),
    TerminusModule,
    ConditionalModule.registerWhen(UsersModule, (env) => !!env.DATABASE_URL),
    ConditionalModule.registerWhen(AuthModule, (env) => !!env.DATABASE_URL),
    NestHttpModule.registerAsync(httpConfig.asProvider()),
    NestI18nModule.forRootAsync(i18nConfig.asProvider()),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ResilienceModule.forRootAsync(resilienceConfig.asProvider()),
    IdempotencyModule.forRootAsync(idempotencyConfig.asProvider()),
    ConditionalModule.registerWhen(
      TypeOrmModule.forRootAsync(databaseConfig.asProvider()),
      (env) => !!env.DATABASE_URL,
    ),
    ConditionalModule.registerWhen(
      ObserveModule.forRootAsync(observeConfig.asProvider()),
      (env) =>
        !!env.OBSERVE_APP_KEY &&
        !!env.OBSERVE_APP_SECRET &&
        !!env.OBSERVE_SERVICE_ID,
    ),
    ConditionalModule.registerWhen(
      ThrottlerModule.forRootAsync(throttleConfig.asProvider()),
      (env) => !!env.REDIS_URL,
    ),
    ConditionalModule.registerWhen(
      BullModule.forRootAsync(queueConfig.asProvider()),
      (env) => !!env.REDIS_URL,
    ),
    ConditionalModule.registerWhen(
      BullModule.registerQueue({ name: 'mail' }),
      (env) => !!env.REDIS_URL,
    ),
    ConditionalModule.registerWhen(
      MailerModule.forRootAsync(mailConfig.asProvider()),
      (env) => !!env.MAIL_HOST,
    ),
  ],
  controllers: [AppController, HealthController],
  providers: [
    AppService,
    ResilientHttpService,
    {
      provide: APP_GUARD,
      useFactory: async (reflector: Reflector) => {
        if (!process.env.REDIS_URL) {
          return { canActivate: () => true };
        }
        const config = await throttleConfig();
        return new ThrottlerGuard(config, (config as any).storage, reflector);
      },
      inject: [Reflector],
    },
  ],
})
export class AppModule {}