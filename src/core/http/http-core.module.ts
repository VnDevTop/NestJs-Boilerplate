import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HttpModule, HttpService } from '@nestjs/axios';
import type { InternalAxiosRequestConfig } from 'axios';

import {
  httpConfig,
  HttpConfig,
  HTTP_CONFIG,
} from '../../configs/http.config.js';
import { getRequestId } from '../../common/utils/index.js';
import { REQUEST_ID_HEADER } from './http.error.js';

/**
 * Shared outbound HTTP client for the whole application.
 *
 * Every third-party call (webhooks, breach lookups, subscription deliveries)
 * goes through the single `HttpService` provided here, so timeout, error
 * classification and request-id propagation live in one place instead of being
 * invented at each call site.
 *
 * Import this module wherever `HttpService` is needed; do not import
 * `HttpModule` directly.
 */
@Module({
  imports: [
    ConfigModule.forFeature(httpConfig),
    HttpModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const cfg = configService.get<HttpConfig>(HTTP_CONFIG) ?? {
          timeoutMs: 5_000,
          maxRedirects: 5,
        };
        return {
          global: true,
          timeout: cfg.timeoutMs,
          maxRedirects: cfg.maxRedirects,
          headers: {
            'Content-Type': 'application/json',
          },
        };
      },
      inject: [ConfigService],
    }),
  ],
  providers: [],
  exports: [HttpService],
})
export class HttpCoreModule implements OnModuleInit {
  constructor(private readonly http: HttpService) {}

  onModuleInit(): void {
    // Every outbound call carries the request id of the request in flight, so a
    // third party can quote it back when reporting a failure.
    this.http.axiosRef.interceptors.request.use(
      (config: InternalAxiosRequestConfig): InternalAxiosRequestConfig => {
        const requestId = getRequestId();
        if (requestId) {
          config.headers = config.headers ?? {};
          config.headers[REQUEST_ID_HEADER] = requestId;
        }
        return config;
      },
    );
  }
}
