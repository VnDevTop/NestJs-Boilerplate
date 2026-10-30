import { registerAs } from '@nestjs/config';
import type { CorsOptions } from 'cors';

export const corsConfig = registerAs<CorsOptions>(
  'cors',
  (): CorsOptions => ({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
    credentials: process.env.CORS_CREDENTIALS === 'true',
  }),
);