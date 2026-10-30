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

export {};