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
    }
  }
}