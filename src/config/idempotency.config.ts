import { registerAs } from '@nestjs/config';
import type { IdempotencyModuleOptions } from '@nestjs/idempotency';
import type { Duration } from '@nestjs/idempotency';

export const idempotencyConfig = registerAs<IdempotencyModuleOptions>(
  'idempotency',
  (): IdempotencyModuleOptions => ({
    header: process.env.IDEMPOTENCY_HEADER ?? 'Idempotency-Key',
    ttl: (process.env.IDEMPOTENCY_TTL ?? '24h') as Duration,
    lockTtl: (process.env.IDEMPOTENCY_LOCK_TTL ?? '60s') as Duration,
    allowInMemoryStorage: true,
  }),
);