import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule, ObserveInstrument } from './app.module.js';
import type { CorsOptions } from 'cors';
import type { SwaggerConfig } from './config/swagger.config.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const configService = app.get(ConfigService);

  app.useSecurityHeaders();
  const cors = configService.getOrThrow<CorsOptions>('cors');
  app.enableCors({
    origin: cors.origin,
    credentials: cors.credentials,
  });

  const swagger = configService.getOrThrow<SwaggerConfig>('swagger');

  const baseBuilder = new DocumentBuilder()
    .setTitle(swagger.title)
    .setDescription(swagger.description)
    .setVersion(swagger.version)
    .addBearerAuth();

  const publicDocument = SwaggerModule.createDocument(app, baseBuilder.build());
  SwaggerModule.setup(swagger.path, app, publicDocument, {
    swaggerOptions: { persistAuthorization: true },
  });

  if (process.env.NODE_ENV !== 'production') {
    const adminBuilder = new DocumentBuilder()
      .setTitle(`${swagger.title} (Admin)`)
      .setDescription(`Administrative endpoints. ${swagger.description}`)
      .setVersion(swagger.version)
      .addBearerAuth();
    const adminDocument = SwaggerModule.createDocument(app, adminBuilder.build());
    SwaggerModule.setup(swagger.adminPath, app, adminDocument, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  await app.listen(process.env.PORT ?? 3000);
}

await bootstrap();