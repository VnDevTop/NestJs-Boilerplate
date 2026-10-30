import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_NAME: z.string().min(1).default('nestjs-boilerplate'),
  API_PREFIX: z.string().min(1).default('api'),
  DATABASE_URL: z.string().min(1).optional(),
  DB_SYNCHRONIZE: z.string().optional().transform((v) => v === 'true'),
  DB_LOGGING: z.string().optional().transform((v) => v === 'true'),
  DB_SSL: z.string().optional().transform((v) => v === 'true'),
  OBSERVE_APP_KEY: z.string().min(1).optional(),
  OBSERVE_APP_SECRET: z.string().min(1).optional(),
  OBSERVE_SERVICE_ID: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  CORS_ORIGIN: z.string().optional(),
  CORS_CREDENTIALS: z.string().optional(),
  CACHE_TTL: z.string().optional(),
  THROTTLE_TTL: z.string().optional(),
  THROTTLE_LIMIT: z.string().optional(),
  MAIL_HOST: z.string().optional(),
  MAIL_PORT: z.string().optional(),
  MAIL_USER: z.string().optional(),
  MAIL_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  MAIL_SECURE: z.string().optional(),
  HTTP_TIMEOUT: z.string().optional(),
  HTTP_MAX_REDIRECTS: z.string().optional(),
  SWAGGER_TITLE: z.string().optional(),
  SWAGGER_DESCRIPTION: z.string().optional(),
  SWAGGER_VERSION: z.string().optional(),
  SWAGGER_PATH: z.string().optional(),
  I18N_FALLBACK_LANGUAGE: z.string().optional(),
  I18N_SUPPORTED_LANGUAGES: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, any>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Environment validation failed: ${message}`);
  }
  return result.data;
}

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NODE_ENV?: 'development' | 'production' | 'test';
      PORT?: string;
      APP_NAME?: string;
      API_PREFIX?: string;
      DATABASE_URL?: string;
      DB_SYNCHRONIZE?: string;
      DB_LOGGING?: string;
      DB_SSL?: string;
      OBSERVE_APP_KEY?: string;
      OBSERVE_APP_SECRET?: string;
      OBSERVE_SERVICE_ID?: string;
      REDIS_URL?: string;
      CORS_ORIGIN?: string;
      CORS_CREDENTIALS?: string;
      CACHE_TTL?: string;
      THROTTLE_TTL?: string;
      THROTTLE_LIMIT?: string;
      MAIL_HOST?: string;
      MAIL_PORT?: string;
      MAIL_USER?: string;
      MAIL_PASSWORD?: string;
      MAIL_FROM?: string;
      MAIL_SECURE?: string;
      HTTP_TIMEOUT?: string;
      HTTP_MAX_REDIRECTS?: string;
      SWAGGER_TITLE?: string;
      SWAGGER_DESCRIPTION?: string;
      SWAGGER_VERSION?: string;
      SWAGGER_PATH?: string;
      I18N_FALLBACK_LANGUAGE?: string;
      I18N_SUPPORTED_LANGUAGES?: string;
    }
  }
}