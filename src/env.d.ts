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
      RESILIENCE_RETRY_ATTEMPTS?: string;
      RESILIENCE_TIMEOUT_MS?: string;
      RESILIENCE_CB_FAILURE_RATE?: string;
      RESILIENCE_CB_OPEN_DURATION?: string;
      RESILIENCE_BULKHEAD_CONCURRENCY?: string;
      RESILIENCE_BULKHEAD_QUEUE?: string;
      IDEMPOTENCY_HEADER?: string;
      IDEMPOTENCY_TTL?: string;
      IDEMPOTENCY_LOCK_TTL?: string;
      SWAGGER_TITLE?: string;
      SWAGGER_DESCRIPTION?: string;
      SWAGGER_VERSION?: string;
      SWAGGER_PATH?: string;
      I18N_FALLBACK_LANGUAGE?: string;
      JWT_PRIVATE_KEY?: string;
      JWT_PUBLIC_KEY?: string;
      JWT_ACCESS_TTL?: string;
      JWT_REFRESH_TTL?: string;
      AUTH_MAX_FAILED_ATTEMPTS?: string;
      AUTH_LOCK_DURATION_MINUTES?: string;
      I18N_SUPPORTED_LANGUAGES?: string;
    }
  }
}

export {};