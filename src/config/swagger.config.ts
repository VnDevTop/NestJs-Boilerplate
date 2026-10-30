import { registerAs } from '@nestjs/config';

export interface SwaggerConfig {
  title: string;
  description: string;
  version: string;
  path: string;
  adminPath: string;
}

export const swaggerConfig = registerAs<SwaggerConfig>(
  'swagger',
  (): SwaggerConfig => ({
    title: process.env.SWAGGER_TITLE ?? 'NestJS Boilerplate API',
    description: process.env.SWAGGER_DESCRIPTION ?? 'Production-ready NestJS boilerplate API',
    version: process.env.SWAGGER_VERSION ?? '1.0.0',
    path: process.env.SWAGGER_PATH ?? 'api/docs',
    adminPath: 'api/docs/admin',
  }),
);