import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AdminModule } from '../../modules/index.js';

export function setupSwagger(app: INestApplication): void {
  const configService = app.get(ConfigService);

  const enabled = configService.get<boolean>('swagger.enabled', true);

  if (!enabled) {
    return;
  }

  const title = configService.get<string>('swagger.title', 'NestPlate API');
  const description = configService.get<string>(
    'swagger.description',
    'Production-ready NestJS 12 reference application API documentation',
  );
  const version = configService.get<string>('swagger.version', '1.0.0');
  const path = configService.get<string>('swagger.path', 'docs');

  const container = (
    app as {
      container?: { getModules(): Map<unknown, { metatype: Function | null }> };
    }
  ).container;
  const moduleMetatypes = container
    ? [...container.getModules().values()]
        .map((moduleRef) => moduleRef.metatype)
        .filter((metatype): metatype is Function => Boolean(metatype))
    : [];
  const uniqueMetatypes = [...new Set(moduleMetatypes)];
  const normalInclude =
    uniqueMetatypes.length > 0
      ? uniqueMetatypes.filter((metatype) => metatype !== AdminModule)
      : undefined;

  const bearerAuth = {
    type: 'http' as const,
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Enter JWT access token',
  };

  const normalConfig = new DocumentBuilder()
    .setTitle(title)
    .setDescription(description)
    .setVersion(version)
    .addBearerAuth(bearerAuth, 'access-token')
    .addTag('Auth', 'Authentication endpoints')
    .addTag('Users', 'User management endpoints')
    .build();

  const adminConfig = new DocumentBuilder()
    .setTitle(`${title} (Admin)`)
    .setDescription('Admin scoped endpoints')
    .setVersion(version)
    .addBearerAuth(bearerAuth, 'access-token')
    .addTag('Admin', 'Admin scoped endpoints')
    .build();

  const normalDocument = SwaggerModule.createDocument(app, normalConfig, {
    include: normalInclude,
  });
  const adminDocument = SwaggerModule.createDocument(app, adminConfig, {
    include: [AdminModule],
  });

  SwaggerModule.setup(path, app, normalDocument, {
    swaggerOptions: { persistAuthorization: true },
  });
  SwaggerModule.setup(`${path}/admin`, app, adminDocument, {
    swaggerOptions: { persistAuthorization: true },
  });
}
