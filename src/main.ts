import { ConsoleLogger, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createAppLogger } from './core/index.js';
import { configureApp } from './bootstrap.js';

import { AppModule, ObserveInstrument } from './app.module.js';

const env = process.env.NODE_ENV ?? 'development';
const logLevels = ['error', 'warn', 'log', 'debug', 'verbose'] as const;

async function bootstrap() {
  // Development keeps Nest's own logger: it is coloured and prints how long each
  // module took to initialise, which is the number worth watching while working
  // and is lost the moment output becomes JSON. Production gets one JSON object
  // per line, correlated by request id, for something to parse.
  const logger =
    env === 'production'
      ? createAppLogger()
      : new ConsoleLogger({
          logLevels: [...logLevels],
          timestamp: env === 'development',
        });

  // Set before the container is created, because module resolution logs through
  // the static Logger while the graph is still being built, and that output has
  // to reach the same destination as everything after it.
  Logger.overrideLogger(logger);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    instrument: ObserveInstrument,
    logger,
  });

  // Prefix, versioning, helmet, CORS, the validation pipe, the filters, the
  // response wrapper and swagger. See `bootstrap.ts` for why this is not inline:
  // the end-to-end suite boots the application through the same function, so what
  // it asserts is what a client receives.
  configureApp(app);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port', 3000);

  app.enableShutdownHooks();

  await app.listen(port);
}

await bootstrap();
