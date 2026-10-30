import { registerAs } from '@nestjs/config';
import type { BullRootModuleOptions } from '@nestjs/bullmq';

export type QueueConfig = BullRootModuleOptions;

export const queueConfig = registerAs<QueueConfig>(
  'queue',
  (): QueueConfig => ({
    prefix: 'queue:',
    connection: { url: process.env.REDIS_URL! },
  }),
);