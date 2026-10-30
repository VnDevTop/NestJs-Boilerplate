import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateEnv } from './env.validation.js';
import { appConfig } from './app.config.js';
import { cacheConfig } from './cache.config.js';
import { corsConfig } from './cors.config.js';
import { databaseConfig } from './database.config.js';
import { httpConfig } from './http.config.js';
import { i18nConfig } from './i18n.config.js';
import { mailConfig } from './mail.config.js';
import { observeConfig } from './observe.config.js';
import { queueConfig } from './queue.config.js';
import { swaggerConfig } from './swagger.config.js';
import { throttleConfig } from './throttle.config.js';

const ENV_KEYS = [
  'NODE_ENV',
  'PORT',
  'APP_NAME',
  'API_PREFIX',
  'DATABASE_URL',
  'DB_SYNCHRONIZE',
  'DB_LOGGING',
  'DB_SSL',
  'OBSERVE_APP_KEY',
  'OBSERVE_APP_SECRET',
  'OBSERVE_SERVICE_ID',
  'REDIS_URL',
  'CORS_ORIGIN',
  'CORS_CREDENTIALS',
  'CACHE_TTL',
  'THROTTLE_TTL',
  'THROTTLE_LIMIT',
  'MAIL_HOST',
  'MAIL_PORT',
  'MAIL_USER',
  'MAIL_PASSWORD',
  'MAIL_FROM',
  'MAIL_SECURE',
  'HTTP_TIMEOUT',
  'HTTP_MAX_REDIRECTS',
  'SWAGGER_TITLE',
  'SWAGGER_DESCRIPTION',
  'SWAGGER_VERSION',
  'SWAGGER_PATH',
  'I18N_FALLBACK_LANGUAGE',
  'I18N_SUPPORTED_LANGUAGES',
];

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

describe('env validation', () => {
  it('validates a minimal valid env', () => {
    const result = validateEnv({ NODE_ENV: 'test' });
    expect(result.NODE_ENV).toBe('test');
  });

  it('throws on invalid PORT', () => {
    expect(() => validateEnv({ PORT: 'not-a-number' })).toThrow();
  });
});

describe('appConfig', () => {
  it('uses defaults', () => {
    const config = appConfig();
    expect(config.name).toBe('nestjs-boilerplate');
    expect(config.port).toBe(3000);
  });

  it('reads env overrides', () => {
    process.env.APP_NAME = 'my-app';
    process.env.PORT = '4000';
    const config = appConfig();
    expect(config.name).toBe('my-app');
    expect(config.port).toBe(4000);
  });
});

describe('databaseConfig', () => {
  it('builds postgres config', () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost/db';
    process.env.DB_SYNCHRONIZE = 'true';
    const config = databaseConfig();
    expect(config.type).toBe('postgres');
    expect(config.synchronize).toBe(true);
  });
});

describe('observeConfig', () => {
  it('reads observe env', () => {
    process.env.OBSERVE_APP_KEY = 'key';
    process.env.OBSERVE_APP_SECRET = 'secret';
    process.env.OBSERVE_SERVICE_ID = 'svc';
    const config = observeConfig();
    expect(config.appKey).toBe('key');
    expect(config.serviceId).toBe('svc');
  });
});

describe('cacheConfig', () => {
  it('uses memory store when no REDIS_URL', () => {
    const config = cacheConfig();
    expect(config.stores).toBeUndefined();
  });

  it('uses redis store when REDIS_URL is set', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const config = cacheConfig();
    expect(config.stores).toBeDefined();
  });
});

describe('corsConfig', () => {
  it('defaults origin to true', () => {
    const config = corsConfig();
    expect(config.origin).toBe(true);
  });

  it('splits CORS_ORIGIN', () => {
    process.env.CORS_ORIGIN = 'http://a.com,http://b.com';
    const config = corsConfig();
    expect(config.origin).toEqual(['http://a.com', 'http://b.com']);
  });
});

describe('httpConfig', () => {
  it('uses defaults', () => {
    const config = httpConfig();
    expect(config.timeout).toBe(5000);
    expect(config.maxRedirects).toBe(5);
  });
});

describe('i18nConfig', () => {
  it('uses defaults', () => {
    const config = i18nConfig();
    expect(config.fallbackLanguage).toBe('en');
  });
});

describe('mailConfig', () => {
  it('returns undefined transport without MAIL_HOST', () => {
    const config = mailConfig();
    expect(config.transport).toBeUndefined();
  });

  it('builds transport with MAIL_HOST', () => {
    process.env.MAIL_HOST = 'smtp.example.com';
    process.env.MAIL_USER = 'user';
    process.env.MAIL_PASSWORD = 'pass';
    const config = mailConfig();
    expect((config.transport as any).host).toBe('smtp.example.com');
  });
});

describe('queueConfig', () => {
  it('builds connection from REDIS_URL', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const config = queueConfig();
    expect((config.connection as any).url).toBe('redis://localhost:6379');
  });
});

describe('swaggerConfig', () => {
  it('uses defaults', () => {
    const config = swaggerConfig();
    expect(config.path).toBe('api/docs');
    expect(config.adminPath).toBe('api/docs/admin');
  });
});

describe('throttleConfig', () => {
  it('has no storage without REDIS_URL', async () => {
    const config = await throttleConfig();
    expect(config.storage).toBeUndefined();
  });
});