import { registerAs } from '@nestjs/config';
import type { CorsOptions } from 'cors';

export interface CorsConfig extends CorsOptions {}

export const corsConfig = registerAs<CorsConfig>(
  'cors',
  (): CorsConfig => ({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
    credentials: process.env.CORS_CREDENTIALS === 'true',
  }),
);