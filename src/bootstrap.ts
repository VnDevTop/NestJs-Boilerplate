import { VersioningType } from '@nestjs/common';
import type { CorsOptions } from '@nestjs/common/internal';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';

import helmet from 'helmet';

import {
  AllExceptionsFilter,
  HttpExceptionFilter,
} from './common/filters/index.js';
import { ResponseTransformInterceptor } from './common/interceptors/index.js';
import { createGlobalValidationPipe } from './common/pipes/index.js';
import { SentryService, setupSwagger, TracingService } from './core/index.js';

import type { SecurityConfig } from './configs/index.js';

/**
 * Everything that turns a Nest application into *this* application.
 *
 * It used to live inline in `main.ts`, which is correct for a binary and wrong for
 * everything else: the global prefix, the URI versioning, the validation pipe,
 * the filters and the response wrapper are all part of what a client sees, and a
 * test that boots the application without them is testing a different one.
 *
 * The e2e suite is the reason this is here. It was reaching `/health` at
 * `/health` because `setGlobalPrefix` had never been called, so every assertion
 * about a URL was a guess, and its response assertions were reading a bare body
 * while a client would receive `{ success, data, timestamp }`. Both failures were
 * the harness's, not the application's, and neither could have been found by
 * reading a controller.
 *
 * `main.ts` creates the application and calls this; the e2e harness creates one
 * and calls this. One wiring, so the two cannot disagree.
 *
 * Called before `app.init()`, because pipes, filters and interceptors registered
 * after initialisation do not apply to requests already resolved.
 */
export function configureApp(app: INestApplication): INestApplication {
  const configService = app.get(ConfigService);

  const globalPrefix = configService.get<string>('app.globalPrefix', 'api');
  const version = configService.get<string>('app.version', '1');
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

  return app;
}

/** The path a client calls, derived from the same config the app registered. */
export function apiRoot(app: INestApplication): string {
  const configService = app.get(ConfigService);

  return `/${configService.get<string>('app.globalPrefix', 'api')}/v${configService.get<string>('app.version', '1')}`;
}
