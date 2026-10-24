import { ConsoleLogger, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';

import { createAppLogger } from './core/index.js';
import { configureApp } from './bootstrap.js';

import { AppModule, ObserveInstrument } from './app.module.js';

const env = process.env.NODE_ENV ?? 'development';
const logLevels = ['error', 'warn', 'log', 'debug', 'verbose'] as const;

async function bootstrap() {
  const logger =
    env === 'production'
      ? createAppLogger()
      : new ConsoleLogger({
          logLevels: [...logLevels],
          timestamp: env === 'development',
        });

  Logger.overrideLogger(logger);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    {
      instrument: ObserveInstrument,
      logger,
    },
  );

  configureApp(app);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port', 3000);

  app.enableShutdownHooks();

  await app.listen(port);
}

await bootstrap();
