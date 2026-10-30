import { registerAs } from '@nestjs/config';

export interface AppConfig {
  name: string;
  env: 'development' | 'production' | 'test';
  port: number;
  apiPrefix: string;
}

export const appConfig = registerAs<AppConfig>(
  'app',
  (): AppConfig => ({
    name: process.env.APP_NAME ?? 'nestjs-boilerplate',
    env: (process.env.NODE_ENV as AppConfig['env']) ?? 'development',
    port: Number(process.env.PORT ?? 3000),
    apiPrefix: process.env.API_PREFIX ?? 'api',
  }),
);