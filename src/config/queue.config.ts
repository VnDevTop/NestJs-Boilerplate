import { registerAs } from '@nestjs/config';
import type { BullRootModuleOptions } from '@nestjs/bullmq';

export const queueConfig = registerAs<BullRootModuleOptions>(
  'queue',
  (): BullRootModuleOptions => ({
    prefix: 'queue:',
    connection: { url: process.env.REDIS_URL! },
  }),
);