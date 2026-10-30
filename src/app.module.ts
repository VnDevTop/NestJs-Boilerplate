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
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { HealthController } from './health.controller.js';
import { validateEnv } from './config/env.validation.js';
import { appConfig } from './config/app.config.js';
import { cacheConfig } from './config/cache.config.js';
import { corsConfig } from './config/cors.config.js';
import { databaseConfig } from './config/database.config.js';
import { httpConfig } from './config/http.config.js';
import { i18nConfig } from './config/i18n.config.js';
import { mailConfig } from './config/mail.config.js';
import { observeConfig } from './config/observe.config.js';
import { queueConfig } from './config/queue.config.js';
import { swaggerConfig } from './config/swagger.config.js';
import { throttleConfig } from './config/throttle.config.js';

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
    NestHttpModule.registerAsync(httpConfig.asProvider()),
    NestI18nModule.forRootAsync(i18nConfig.asProvider()),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
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
    {
      provide: APP_GUARD,
      useFactory: async (reflector: Reflector) => {
        if (!process.env.REDIS_URL) {
          return { canActivate: () => true };
        }
        const config = await throttleConfig();
        return new ThrottlerGuard(config, config.storage!, reflector);
      },
      inject: [Reflector],
    },
  ],
})
export class AppModule {}