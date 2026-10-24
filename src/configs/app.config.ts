import { registerAs } from '@nestjs/config';

export interface AppConfig {
  env: string;
  name: string;
  port: number;
  globalPrefix: string;
  version: string;
  /**
   * Absolute base url of this deployment, with no trailing slash.
   *
   * Every link in an email is built from it: password reset, email
   * verification, account locked. A relative link in a mail body is dead on
   * arrival, and a wrong one sends a token to somebody else, so this is
   * required in production and validated as an absolute https url there.
   */
  url: string;
}

export const appConfig = registerAs('app', (): AppConfig => ({
  env: process.env.NODE_ENV ?? 'development',
  name: process.env.APP_NAME ?? 'nestjs-boilerplate',
  port: Number(process.env.PORT ?? 3000),
  globalPrefix: process.env.API_PREFIX ?? 'api',
  version: process.env.API_VERSION ?? '1',
  // Trailing slashes are stripped so a join never produces a double slash in a
  // verification link.
  url: (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
}));
