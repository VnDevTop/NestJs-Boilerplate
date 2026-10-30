import { registerAs } from '@nestjs/config';
import type { HttpModuleOptions } from '@nestjs/axios';

export interface HttpConfig extends HttpModuleOptions {}

export const httpConfig = registerAs<HttpConfig>(
  'http',
  (): HttpConfig => ({
    timeout: Number(process.env.HTTP_TIMEOUT ?? 5000),
    maxRedirects: Number(process.env.HTTP_MAX_REDIRECTS ?? 5),
  }),
);