import { registerAs } from '@nestjs/config';
import type { HttpModuleOptions } from '@nestjs/axios';

export const httpConfig = registerAs<HttpModuleOptions>(
  'http',
  (): HttpModuleOptions => ({
    timeout: Number(process.env.HTTP_TIMEOUT ?? 5000),
    maxRedirects: Number(process.env.HTTP_MAX_REDIRECTS ?? 5),
  }),
);