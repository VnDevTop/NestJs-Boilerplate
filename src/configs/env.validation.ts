import { z } from 'zod';

/**
 * Validates the environment before anything connects, so a missing or unusable
 * setting is a clear error at boot rather than a confusing failure later.
 *
 * Only the rules are custom. Messages are zod's own, because a schema that
 * describes *what* is wrong is enough; the alternative is a lookup table of
 * wording that has to be kept in step with the constraints themselves.
 */

const PLACEHOLDER_SECRETS = new Set([
  'change-me',
  'secret',
  'password',
  'change-me-in-production',
  // The development value shipped in `.env.example`. A deployment that copies
  // the file and forgets this one line would otherwise encrypt every stored TOTP
  // secret with a key that is in the repository.
  'dev-only-2fa-key-generate-your-own',
]);

/** A Postgres schema name reaches DDL unquoted in places, so it is constrained. */
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 2FA is on unless it is explicitly turned off, which is what makes this key required. */
const twoFactorEnabled = (value: string | undefined): boolean =>
  value !== 'false';

/**
 * A retention age, in days, never below one.
 *
 * A day is the floor rather than zero because a zero here means "delete
 * everything older than now", which turns a typo into data loss instead of a
 * failed deploy.
 */
const retentionDays = z.coerce.number().int().min(1);

/**
 * Drops variables set to a blank string.
 *
 * A blank value is how an operator says "nothing here": `.env.example` documents
 * every optional variable as `KEY=` so the file can be copied and edited, and
 * requiring each of those to be deleted by hand would make that file unusable.
 * Doing it once here keeps the schema readable and makes every optional variable
 * behave the same way.
 */
const dropBlanks = (config: unknown): unknown =>
  typeof config === 'object' && config !== null
    ? Object.fromEntries(
        Object.entries(config).filter(
          ([, value]) => !(typeof value === 'string' && value.trim() === ''),
        ),
      )
    : config;

function createEnvSchema(strict: boolean) {
  const secret = strict
    ? z
        .string()
        .min(32)
        .refine((value) => !PLACEHOLDER_SECRETS.has(value), {
          message: 'still holds the example value',
        })
    : z.string().min(1);

  return z.preprocess(
    dropBlanks,
    z
      .object({
        NODE_ENV: z
          .enum(['development', 'test', 'production'])
          .default('development'),
        PORT: z.coerce.number().int().min(1).max(65535).optional(),

        APP_NAME: z.string().min(1).optional(),
        // Every email link is built from this, so a wrong value sends a password
        // reset token to somebody else's deployment. Required, and https, in
        // production; localhost is fine in development.
        APP_URL: strict
          ? z.url().refine((value) => value.startsWith('https://'), {
              message: 'must use https: in production',
            })
          : z.url().optional(),
        // Both end up in the request path, so a slash in them produces a route
        // nobody can call.
        API_PREFIX: z
          .string()
          .regex(/^[A-Za-z0-9_-]+$/)
          .optional(),
        API_VERSION: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .optional(),

        // Enabled only when all three are present, so a partial set is rejected
        // below rather than quietly disabling observability.
        OBSERVE_APP_KEY: z.string().min(1).optional(),
        OBSERVE_APP_SECRET: z.string().min(1).optional(),
        OBSERVE_SERVICE_ID: z.string().min(1).optional(),

        DATABASE_URL: strict
          ? z.url().refine((value) => value.startsWith('postgres'), {
              message: 'must use one of: postgres:, postgresql:',
            })
          : z.string().optional(),
        DATABASE_SSL: z.enum(['true', 'false']).optional(),
        DATABASE_SCHEMA: z.string().regex(SQL_IDENTIFIER).optional(),

        CACHE_URL: z
          .url()
          .refine((value) => /^rediss?:/.test(value), {
            message: 'must use one of: redis:, rediss:',
          })
          .optional(),
        CACHE_BACKEND: z.enum(['redis', 'valkey', 'memory']).optional(),
        CACHE_KEY_PREFIX: z.string().min(1).regex(/^\S+$/).optional(),
        CACHE_DEFAULT_TTL: z.coerce.number().positive().optional(),
        CACHE_EMPTY_TTL: z.coerce.number().positive().optional(),
        CACHE_CONNECT_TIMEOUT: z.coerce.number().positive().optional(),
        CACHE_AUTH_USER_TTL: z.coerce.number().positive().optional(),
        CACHE_AUTH_ROLE_TTL: z.coerce.number().positive().optional(),

        // Redis for the queue and the shared throttler. The cache has its own
        // url, so a deployment can put the two on different servers.
        REDIS_URL: z
          .url()
          .refine((value) => /^rediss?:/.test(value), {
            message: 'must use one of: redis:, rediss:',
          })
          .optional(),
        REDIS_KEY_PREFIX: z.string().min(1).regex(/^\S+$/).optional(),
        REDIS_CONNECT_TIMEOUT: z.coerce.number().positive().optional(),
        REDIS_DISABLE_OFFLINE_QUEUE: z.enum(['true', 'false']).optional(),

        JWT_SECRET: secret,
        JWT_REFRESH_SECRET: secret,
        JWT_EXPIRES_IN: z.string().optional(),
        JWT_REFRESH_EXPIRES_IN: z.string().optional(),

        TWO_FACTOR_ENABLED: z.enum(['true', 'false']).optional(),
        TWO_FACTOR_ENCRYPTION_KEY: z.string().min(1).optional(),
        TWO_FACTOR_ISSUER: z.string().min(1).max(64).optional(),

        SECURITY_ENABLED: z.enum(['true', 'false']).optional(),
        SECURITY_CONTENT_SECURITY_POLICY: z.enum(['true', 'false']).optional(),
        SECURITY_HSTS_MAX_AGE: z.coerce.number().nonnegative().optional(),
        SECURITY_REFERRER_POLICY: z.string().min(1).optional(),

        CORS_ORIGINS: z.string().optional(),
        CORS_CREDENTIALS: z.enum(['true', 'false']).optional(),
        CORS_MAX_AGE: z.coerce.number().nonnegative().optional(),

        THROTTLE_TTL: z.coerce.number().positive().optional(),
        THROTTLE_LIMIT: z.coerce.number().positive().optional(),
        // 0 is meaningful: block for the rest of the window.
        THROTTLE_BLOCK_DURATION: z.coerce.number().nonnegative().optional(),

        // Mail. The provider packages are optional, so these are validated
        // independently of whether any of them is installed: a transport name
        // nobody can resolve is reported below, not here.
        MAIL_TRANSPORT: z
          .enum(['memory', 'smtp', 'ses', 'sendgrid'])
          .optional(),
        MAIL_FROM: z.email().optional(),
        MAIL_FROM_NAME: z.string().min(1).max(128).optional(),
        MAIL_REPLY_TO: z.email().optional(),
        MAIL_SUBJECT_PREFIX: z.string().max(64).optional(),
        MAIL_SMTP_HOST: z.string().min(1).optional(),
        MAIL_SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
        MAIL_SMTP_SECURE: z.enum(['true', 'false']).optional(),
        MAIL_SMTP_USER: z.string().min(1).optional(),
        MAIL_SMTP_PASSWORD: z.string().optional(),
        MAIL_SENDGRID_API_KEY: z.string().min(1).optional(),
        MAIL_SES_REGION: z.string().min(1).optional(),
        MAIL_CONNECTION_TIMEOUT: z.coerce.number().positive().optional(),
        MAIL_SOCKET_TIMEOUT: z.coerce.number().positive().optional(),

        // Notifications. The credential rules are conditional on the channel
        // flag, since an off channel needs no credential.
        NOTIFICATION_ENABLED: z.enum(['true', 'false']).optional(),
        NOTIFICATION_CONSOLE_ENABLED: z.enum(['true', 'false']).optional(),
        NOTIFICATION_TIMEOUT: z.coerce.number().positive().optional(),
        NOTIFICATION_RETRIES: z.coerce.number().int().nonnegative().optional(),
        NOTIFICATION_RETRY_DELAY: z.coerce.number().nonnegative().optional(),
        NOTIFICATION_THROW_ON_FAILURE: z.enum(['true', 'false']).optional(),
        TELEGRAM_ENABLED: z.enum(['true', 'false']).optional(),
        TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
        TELEGRAM_CHAT_ID: z.string().min(1).optional(),
        TELEGRAM_TOPIC_ID: z.string().min(1).optional(),
        SLACK_ENABLED: z.enum(['true', 'false']).optional(),
        SLACK_WEBHOOK_URL: z
          .url()
          .refine((value) => value.startsWith('https://'), {
            message: 'must use https:, a webhook url carries the credential',
          })
          .optional(),
        SLACK_CHANNEL: z.string().min(1).max(64).optional(),
        DISCORD_ENABLED: z.enum(['true', 'false']).optional(),
        DISCORD_WEBHOOK_URL: z
          .url()
          .refine((value) => value.startsWith('https://'), {
            message: 'must use https:, a webhook url carries the credential',
          })
          .optional(),
        DISCORD_CHANNEL: z.string().min(1).max(64).optional(),

        // Queue. The url is required only when the queue is on, since the
        // in-process fallback needs no redis at all.
        QUEUE_ENABLED: z.enum(['true', 'false']).optional(),
        QUEUE_REDIS_URL: z
          .url()
          .refine((value) => /^rediss?:/.test(value), {
            message: 'must use one of: redis:, rediss:',
          })
          .optional(),
        QUEUE_PREFIX: z.string().min(1).regex(/^\S+$/).optional(),
        QUEUE_JOB_TIMEOUT: z.coerce.number().positive().optional(),
        QUEUE_RETRY_ATTEMPTS: z.coerce.number().int().positive().optional(),
        QUEUE_RETRY_DELAY: z.coerce.number().positive().optional(),
        QUEUE_RETRY_MAX_DELAY: z.coerce.number().positive().optional(),
        QUEUE_CONCURRENCY_MAIL: z.coerce.number().int().positive().optional(),
        QUEUE_CONCURRENCY_NOTIFICATION: z.coerce
          .number()
          .int()
          .positive()
          .optional(),
        QUEUE_CONCURRENCY_MAINTENANCE: z.coerce
          .number()
          .int()
          .positive()
          .optional(),
        QUEUE_CONCURRENCY_DIGEST: z.coerce.number().int().positive().optional(),
        QUEUE_REMOVE_COMPLETE_AFTER: z.coerce.number().nonnegative().optional(),
        QUEUE_REMOVE_FAIL_AFTER: z.coerce.number().nonnegative().optional(),
        QUEUE_IN_PROCESS_FALLBACK: z.enum(['true', 'false']).optional(),
        QUEUE_IN_PROCESS_CONCURRENCY: z.coerce
          .number()
          .int()
          .positive()
          .optional(),

        // Retention. Every age is at least one day: a value of 0 or 1 would
        // delete data that is still live, and a typo in a days field is the one
        // mistake here that cannot be undone.
        RETENTION_ENABLED: z.enum(['true', 'false']).optional(),
        RETENTION_DRY_RUN: z.enum(['true', 'false']).optional(),
        RETENTION_SCHEDULE: z.string().min(1).max(64).optional(),
        RETENTION_BATCH_SIZE: z.coerce.number().int().positive().optional(),
        RETENTION_BATCH_DELAY: z.coerce.number().nonnegative().optional(),
        RETENTION_RUN_TIMEOUT: z.coerce.number().positive().optional(),
        RETENTION_USERS_DAYS: retentionDays.optional(),
        RETENTION_EMAIL_TOKENS_DAYS: retentionDays.optional(),
        RETENTION_RESET_TOKENS_DAYS: retentionDays.optional(),
        RETENTION_REFRESH_TOKENS_DAYS: retentionDays.optional(),
        RETENTION_MAIL_LOGS_DAYS: retentionDays.optional(),
        RETENTION_NOTIFICATION_LOGS_DAYS: retentionDays.optional(),
        RETENTION_LOGIN_ATTEMPTS_DAYS: retentionDays.optional(),
        RETENTION_AUDIT_LOGS_DAYS: retentionDays.optional(),

        // Password policy. The bounds are the interesting part: a minimum below
        // the DTOs current value would silently weaken a deployed app. The
        // maximum is a bound on work, not on the hash: scrypt has no 72 byte
        // truncation, so the only reason to cap it is to stop a request carrying
        // a megabyte of password from tying up a hash.
        PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(128).optional(),
        PASSWORD_MAX_LENGTH: z.coerce
          .number()
          .int()
          .min(8)
          .max(1024)
          .optional(),
        PASSWORD_REQUIRE_LOWERCASE: z.enum(['true', 'false']).optional(),
        PASSWORD_REQUIRE_UPPERCASE: z.enum(['true', 'false']).optional(),
        PASSWORD_REQUIRE_NUMBER: z.enum(['true', 'false']).optional(),
        PASSWORD_REQUIRE_SYMBOL: z.enum(['true', 'false']).optional(),
        PASSWORD_HISTORY_COUNT: z.coerce
          .number()
          .int()
          .nonnegative()
          .optional(),
        PASSWORD_CHECK_BREACH_LIST: z.enum(['true', 'false']).optional(),
        LOGIN_MAX_FAILED_ATTEMPTS: z.coerce
          .number()
          .int()
          .nonnegative()
          .optional(),
        LOGIN_LOCKOUT_DURATION: z.coerce.number().int().positive().optional(),

        // Only the seed reads the password, which states the length rule itself.
        // Rejecting it here would stop an app that never seeds from booting.
        ADMIN_EMAIL: z.email().optional(),
        ADMIN_PASSWORD: z.string().optional(),

        SWAGGER_ENABLED: z.enum(['true', 'false']).optional(),
        SWAGGER_TITLE: z.string().min(1).optional(),
        SWAGGER_DESCRIPTION: z.string().min(1).optional(),
        SWAGGER_VERSION: z
          .string()
          .regex(/^\d+\.\d+\.\d+$/)
          .optional(),
        SWAGGER_PATH: z
          .string()
          .regex(/^[A-Za-z0-9_-]+$/)
          .optional(),
      })
      .superRefine((value, ctx) => {
        const observe = [
          'OBSERVE_APP_KEY',
          'OBSERVE_APP_SECRET',
          'OBSERVE_SERVICE_ID',
        ] as const;
        const missing = observe.find((name) => !value[name]);

        // Half configured observability looks exactly like observability that is
        // switched off, which is the part worth complaining about.
        if (missing && observe.some((name) => value[name])) {
          ctx.addIssue({
            code: 'custom',
            path: [missing],
            message: `is required when the other OBSERVE_* variables are set`,
          });
        }

        // Browsers reject credentials with a wildcard, so this pairing only looks
        // like it works. An empty list has the same effect: every origin allowed.
        if (value.CORS_CREDENTIALS === 'true') {
          const origins = (value.CORS_ORIGINS ?? '').trim();

          if (!origins || origins.includes('*')) {
            ctx.addIssue({
              code: 'custom',
              path: ['CORS_CREDENTIALS'],
              message: 'requires an explicit CORS_ORIGINS allow-list',
            });
          }
        }

        // The two-factor config falls back to a published key and is on by default,
        // so a production deploy that forgets this would encrypt secrets with a
        // value that is in the repository.
        if (twoFactorEnabled(value.TWO_FACTOR_ENABLED)) {
          const key = value.TWO_FACTOR_ENCRYPTION_KEY;

          if (!key && strict) {
            ctx.addIssue({
              code: 'custom',
              path: ['TWO_FACTOR_ENCRYPTION_KEY'],
              message: 'is required while two-factor authentication is enabled',
            });
          }

          // Rejected in production only. The other placeholder rules are strict
          // because those variables are required everywhere; this one is
          // deliberately allowed in development, since `.env.example` ships a
          // usable development key and a fresh clone has to boot.
          if (strict && key && PLACEHOLDER_SECRETS.has(key)) {
            ctx.addIssue({
              code: 'custom',
              path: ['TWO_FACTOR_ENCRYPTION_KEY'],
              message: 'still holds the example value',
            });
          }
        }

        // A shared cache without a url would silently aim at localhost, so it is
        // required whenever the backend is not the in-process one.
        if (
          value.CACHE_BACKEND &&
          value.CACHE_BACKEND !== 'memory' &&
          !value.CACHE_URL
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['CACHE_URL'],
            message: `is required when CACHE_BACKEND is ${value.CACHE_BACKEND}`,
          });
        }

        // A channel switched on with no credential is a channel that silently
        // drops every message, which looks identical to a working integration.
        // Reported per channel so the message names the one that is wrong.
        const channels: [flag: string | undefined, ...required: string[]][] = [
          ['TELEGRAM_ENABLED', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
          ['SLACK_ENABLED', 'SLACK_WEBHOOK_URL'],
          ['DISCORD_ENABLED', 'DISCORD_WEBHOOK_URL'],
        ];

        for (const [flag, ...required] of channels) {
          if (value[flag as 'TELEGRAM_ENABLED'] !== 'true') {
            continue;
          }

          for (const name of required) {
            if (!value[name as 'TELEGRAM_BOT_TOKEN']) {
              ctx.addIssue({
                code: 'custom',
                path: [name],
                message: `is required when ${flag} is true`,
              });
            }
          }
        }

        // An enabled queue with no redis would fall back to running in process,
        // which is a slower deployment rather than the intended one, and looks
        // like a healthy app right up until traffic grows.
        if (value.QUEUE_ENABLED === 'true' && !value.QUEUE_REDIS_URL) {
          ctx.addIssue({
            code: 'custom',
            path: ['QUEUE_REDIS_URL'],
            message: 'is required when QUEUE_ENABLED is true',
          });
        }

        // A minimum above the maximum is a policy that rejects every password,
        // which reads as a broken signup form rather than a configuration error.
        if (
          value.PASSWORD_MIN_LENGTH !== undefined &&
          value.PASSWORD_MAX_LENGTH !== undefined &&
          value.PASSWORD_MIN_LENGTH > value.PASSWORD_MAX_LENGTH
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['PASSWORD_MAX_LENGTH'],
            message: 'must be at least PASSWORD_MIN_LENGTH',
          });
        }

        // The cache prefix and the redis prefix must not match. A cache sweep
        // evicts by TTL, so one namespace shared by both means a short cache TTL
        // discards pending jobs and a long one leaves the cache growing.
        if (
          value.REDIS_KEY_PREFIX &&
          value.REDIS_KEY_PREFIX === value.CACHE_KEY_PREFIX
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['REDIS_KEY_PREFIX'],
            message:
              'must differ from CACHE_KEY_PREFIX, a cache sweep would evict queue jobs',
          });
        }

        // The memory transport is the development default and it is a no-op: it
        // keeps messages in a Map and returns success. In production that reads
        // as "mail is being sent" on every dashboard while nothing is delivered,
        // so it is refused at boot rather than discovered by a user.
        //
        // An unset value resolves to memory in `mail.config.ts`, so it counts too:
        // otherwise setting only MAIL_FROM would leave a deployment silently
        // delivering nothing.
        if (strict && (value.MAIL_TRANSPORT ?? 'memory') === 'memory') {
          ctx.addIssue({
            code: 'custom',
            path: ['MAIL_TRANSPORT'],
            message:
              'must not be memory in production, it delivers nothing. Set a provider and install its package.',
          });
        }

        // Without a from address a provider either rejects the message or sends it
        // as from the wrong sender, so a production deploy has to name one.
        if (strict && !value.MAIL_FROM) {
          ctx.addIssue({
            code: 'custom',
            path: ['MAIL_FROM'],
            message: 'is required in production',
          });
        }
      }),
  );
}

/**
 * Turns a zod issue into one readable line, keeping the variable name.
 *
 * A missing value is reported as missing rather than as a type mismatch: zod
 * reports both as `invalid_type` and leaves `received` unset in the missing
 * case, so the original config is what distinguishes them.
 */
function formatIssue(
  issue: z.core.$ZodIssue,
  config: Record<string, unknown>,
): string {
  const name = issue.path.join('.') || 'environment';

  if (issue.code === 'invalid_type' && blank(config[name])) {
    return `- ${name}: is required`;
  }

  return `- ${name}: ${issue.message || 'is invalid'}`;
}

const blank = (value: unknown): boolean =>
  value === undefined || (typeof value === 'string' && value.trim() === '');

export function validateEnvironment(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const strict = String(config.NODE_ENV ?? 'development') === 'production';
  const result = createEnvSchema(strict).safeParse(config);

  if (!result.success) {
    // Every problem at once, since restarting to discover the next one is
    // exactly the loop this is meant to remove.
    const problems = result.error.issues
      .map((issue) => formatIssue(issue, config))
      .join('\n');

    throw new Error(`Invalid environment configuration:\n  ${problems}`);
  }

  // The original object is returned, not the parsed one. Each config file does
  // its own Number() conversion, so handing back zod's coerced values would
  // change types that ConfigService callers already handle.
  return config;
}
