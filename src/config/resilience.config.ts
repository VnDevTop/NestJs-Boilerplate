import { registerAs } from '@nestjs/config';
import type { ResilienceModuleOptions } from '@nestjs/resilience';

export const resilienceConfig = registerAs<ResilienceModuleOptions>(
  'resilience',
  (): ResilienceModuleOptions => ({
    mapErrors: true,
    defaults: {
      retry: { attempts: Number(process.env.RESILIENCE_RETRY_ATTEMPTS ?? 3) },
      timeout: Number(process.env.RESILIENCE_TIMEOUT_MS ?? 5000),
    },
    presets: {
      http: {
        retry: { attempts: Number(process.env.RESILIENCE_RETRY_ATTEMPTS ?? 3) },
        timeout: Number(process.env.RESILIENCE_TIMEOUT_MS ?? 5000),
        circuitBreaker: {
          failureRateThreshold: Number(process.env.RESILIENCE_CB_FAILURE_RATE ?? 50),
          openDuration: (process.env.RESILIENCE_CB_OPEN_DURATION ?? '30s') as any,
        },
        bulkhead: {
          maxConcurrent: Number(process.env.RESILIENCE_BULKHEAD_CONCURRENCY ?? 10),
          maxQueue: Number(process.env.RESILIENCE_BULKHEAD_QUEUE ?? 10),
        },
      },
    },
  }),
);