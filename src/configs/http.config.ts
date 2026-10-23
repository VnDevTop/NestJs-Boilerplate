import { registerAs } from '@nestjs/config';

/**
 * Global configuration for outbound HTTP calls through `HttpCoreModule`.
 *
 * Every module that calls out to a third party should use the shared
 * `HttpService` from `HttpCoreModule` rather than constructing its own, so
 * timeouts, error handling and request-id propagation live in one place.
 */
export interface HttpConfig {
  /** Default timeout in milliseconds applied to every outbound call. */
  readonly timeoutMs: number;
  /** Maximum number of redirects to follow. */
  readonly maxRedirects: number;
}

export const httpConfig = registerAs('http', (): HttpConfig => ({
  timeoutMs: Number(process.env.HTTP_TIMEOUT_MS ?? 5_000),
  maxRedirects: Number(process.env.HTTP_MAX_REDIRECTS ?? 5),
}));

export const HTTP_CONFIG = 'http';
