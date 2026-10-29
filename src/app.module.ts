import { Module } from '@nestjs/common';
import { ConfigModule, ConditionalModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { validateEnv } from './config/env.validation.js';
import { appConfig } from './config/app.config.js';
import { databaseConfig } from './config/database.config.js';
import { observeConfig } from './config/observe.config.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, observeConfig],
      validate: validateEnv,
      envFilePath: ['.env', '.env.local'],
    }),
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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}