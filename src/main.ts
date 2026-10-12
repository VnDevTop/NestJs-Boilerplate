import { ConsoleLogger, Logger, VersioningType } from '@nestjs/common';
import { CorsOptions } from '@nestjs/common/internal';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import helmet from 'helmet';
import {
  AllExceptionsFilter,
  HttpExceptionFilter,
} from './common/filters/index.js';
import { ResponseTransformInterceptor } from './common/interceptors/index.js';
import { createGlobalValidationPipe } from './common/pipes/index.js';
import {
  createAppLogger,
  SentryService,
  setupSwagger,
  TracingService,
} from './core/index.js';

import type { SecurityConfig } from './configs/index.js';
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

  const configService = app.get(ConfigService);

  const globalPrefix = configService.get<string>('app.globalPrefix', 'api');
  const version = configService.get<string>('app.version', '1');
  const port = configService.get<number>('app.port', 3000);
  const security = configService.getOrThrow<SecurityConfig>('security');
  const cors = configService.getOrThrow<CorsOptions>('cors');

  app.setGlobalPrefix(globalPrefix);

  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: version,
  });

  // The config already holds helmet's options, so only the app level switch is
  // taken out before handing the rest over.
  const { enabled: securityEnabled, ...securityHeaders } = security;

  if (securityEnabled) {
    app.use(helmet(securityHeaders));
  }

  // No allow-list configured means same-origin only, so nothing is enabled.
  if (cors.origin) {
    app.enableCors(cors);
  }

  app.useGlobalPipes(createGlobalValidationPipe());
  // The reporting services come from the container rather than being constructed
  // here, because `SentryService` initialises the SDK and that must happen once
  // per process — a second `init` discards the first one's configuration, which is
  // the kind of bug that reads as a broken DSN.
  app.useGlobalFilters(
    new AllExceptionsFilter(app.get(SentryService), app.get(TracingService)),
    new HttpExceptionFilter(),
  );
  app.useGlobalInterceptors(new ResponseTransformInterceptor());

  setupSwagger(app);

  // Lets the container send SIGTERM and lets the app finish in-flight requests,
  // close its database pool and drain before the process exits.
  app.enableShutdownHooks();

  await app.listen(port);
}

await bootstrap();
