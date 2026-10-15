declare namespace NodeJS {
  interface ProcessEnv {
    NODE_ENV: 'development' | 'production' | 'test';

    PORT: string;
    APP_NAME?: string;
    // Absolute base url, required and https in production. Every email link is
    // built from it.
    APP_URL?: string;
    API_PREFIX?: string;
    API_VERSION?: string;

    OBSERVE_APP_KEY?: string;
    OBSERVE_APP_SECRET?: string;
    OBSERVE_SERVICE_ID?: string;

    // DATABASE_HOST: string;
    // DATABASE_PORT: number;
    // DATABASE_NAME: string;
    // DATABASE_USER: string;
    // DATABASE_PASSWORD: string;
    DATABASE_URL: string;
    DATABASE_SSL?: 'true' | 'false';
    DATABASE_SCHEMA?: string;

    TWO_FACTOR_ENABLED?: 'true' | 'false';
    TWO_FACTOR_ENCRYPTION_KEY?: string;
    TWO_FACTOR_ISSUER?: string;

    CACHE_BACKEND?: 'redis' | 'valkey' | 'memory';
    CACHE_URL?: string;
    CACHE_KEY_PREFIX?: string;
    CACHE_DEFAULT_TTL?: string;
    CACHE_EMPTY_TTL?: string;
    CACHE_CONNECT_TIMEOUT?: string;

    // Redis for the queue and the shared throttler. Distinct from the cache
    // namespace: a cache sweep must not evict a pending job.
    REDIS_URL?: string;
    REDIS_KEY_PREFIX?: string;
    REDIS_CONNECT_TIMEOUT?: string;
    REDIS_DISABLE_OFFLINE_QUEUE?: 'true' | 'false';

    SECURITY_ENABLED?: string;
    SECURITY_CONTENT_SECURITY_POLICY?: string;
    SECURITY_HSTS_MAX_AGE?: string;
    SECURITY_REFERRER_POLICY?: string;

    CORS_ORIGINS?: string;
    CORS_CREDENTIALS?: string;
    CORS_MAX_AGE?: string;

    THROTTLE_TTL?: string;
    THROTTLE_LIMIT?: string;
    THROTTLE_BLOCK_DURATION?: string;

    // Mail. Every provider package is optional, so only the transport choice and
    // the from address matter to the app; the credentials belong to whichever
    // provider is selected.
    MAIL_TRANSPORT?: 'memory' | 'smtp' | 'ses' | 'sendgrid';
    MAIL_FROM?: string;
    MAIL_FROM_NAME?: string;
    MAIL_REPLY_TO?: string;
    MAIL_SUBJECT_PREFIX?: string;
    MAIL_SMTP_HOST?: string;
    MAIL_SMTP_PORT?: string;
    MAIL_SMTP_SECURE?: 'true' | 'false';
    MAIL_SMTP_USER?: string;
    MAIL_SMTP_PASSWORD?: string;
    MAIL_SENDGRID_API_KEY?: string;
    MAIL_SES_REGION?: string;
    MAIL_CONNECTION_TIMEOUT?: string;
    MAIL_SOCKET_TIMEOUT?: string;

    // Notifications. No channel needs a package, so these are pure
    // configuration. A channel that is off does not need its credentials.
    NOTIFICATION_ENABLED?: 'true' | 'false';
    NOTIFICATION_CONSOLE_ENABLED?: 'true' | 'false';
    NOTIFICATION_TIMEOUT?: string;
    NOTIFICATION_RETRIES?: string;
    NOTIFICATION_RETRY_DELAY?: string;
    NOTIFICATION_THROW_ON_FAILURE?: 'true' | 'false';
    TELEGRAM_ENABLED?: 'true' | 'false';
    TELEGRAM_BOT_TOKEN?: string;
    TELEGRAM_CHAT_ID?: string;
    TELEGRAM_TOPIC_ID?: string;
    SLACK_ENABLED?: 'true' | 'false';
    SLACK_WEBHOOK_URL?: string;
    SLACK_CHANNEL?: string;
    DISCORD_ENABLED?: 'true' | 'false';
    DISCORD_WEBHOOK_URL?: string;
    DISCORD_CHANNEL?: string;

    // Queue. bullmq is optional, so the queue is off until it is installed and
    // this flag is set; the same processors then run in process.
    QUEUE_ENABLED?: 'true' | 'false';
    QUEUE_REDIS_URL?: string;
    QUEUE_PREFIX?: string;
    QUEUE_JOB_TIMEOUT?: string;
    QUEUE_RETRY_ATTEMPTS?: string;
    QUEUE_RETRY_DELAY?: string;
    QUEUE_RETRY_MAX_DELAY?: string;
    QUEUE_CONCURRENCY_MAIL?: string;
    QUEUE_CONCURRENCY_NOTIFICATION?: string;
    QUEUE_CONCURRENCY_MAINTENANCE?: string;
    QUEUE_CONCURRENCY_DIGEST?: string;
    QUEUE_REMOVE_COMPLETE_AFTER?: string;
    QUEUE_REMOVE_FAIL_AFTER?: string;
    QUEUE_IN_PROCESS_FALLBACK?: 'true' | 'false';
    QUEUE_IN_PROCESS_CONCURRENCY?: string;

    // Retention. Off by default; every age is the policy from the plan, and the
    // validation refuses an age below a day so a typo cannot delete fresh data.
    RETENTION_ENABLED?: 'true' | 'false';
    RETENTION_DRY_RUN?: 'true' | 'false';
    RETENTION_SCHEDULE?: string;
    RETENTION_BATCH_SIZE?: string;
    RETENTION_BATCH_DELAY?: string;
    RETENTION_RUN_TIMEOUT?: string;
    RETENTION_USERS_DAYS?: string;
    RETENTION_EMAIL_TOKENS_DAYS?: string;
    RETENTION_RESET_TOKENS_DAYS?: string;
    RETENTION_REFRESH_TOKENS_DAYS?: string;
    RETENTION_MAIL_LOGS_DAYS?: string;
    RETENTION_NOTIFICATION_LOGS_DAYS?: string;
    RETENTION_LOGIN_ATTEMPTS_DAYS?: string;
    RETENTION_AUDIT_LOGS_DAYS?: string;

    // Password policy. The defaults match the @MinLength(8) the auth DTOs
    // enforce today, so nothing tightens or loosens before Phase 19 reads them.
    PASSWORD_MIN_LENGTH?: string;
    PASSWORD_MAX_LENGTH?: string;
    PASSWORD_REQUIRE_LOWERCASE?: 'true' | 'false';
    PASSWORD_REQUIRE_UPPERCASE?: 'true' | 'false';
    PASSWORD_REQUIRE_NUMBER?: 'true' | 'false';
    PASSWORD_REQUIRE_SYMBOL?: 'true' | 'false';
    PASSWORD_HISTORY_COUNT?: string;
    PASSWORD_CHECK_BREACH_LIST?: 'true' | 'false';
    LOGIN_MAX_FAILED_ATTEMPTS?: string;
    LOGIN_LOCKOUT_DURATION?: string;

    ADMIN_EMAIL?: string;
    ADMIN_PASSWORD?: string;

    JWT_SECRET: string;
    JWT_EXPIRES_IN: number | StringValue;
    JWT_REFRESH_SECRET: string;
    JWT_REFRESH_EXPIRES_IN: number | StringValue;
    SESSION_ABSOLUTE_TTL_SECONDS: number;

    SWAGGER_ENABLED?: 'true' | 'false';
    SWAGGER_TITLE?: string;
    SWAGGER_DESCRIPTION?: string;
    SWAGGER_VERSION?: string;
    SWAGGER_PATH?: string;
  }
}
