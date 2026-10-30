import { registerAs } from '@nestjs/config';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import { RedisThrottlerStorage } from '@nestjs-redis/throttler-storage';
import { createClient } from 'redis';

export const throttleConfig = registerAs<ThrottlerModuleOptions>(
  'throttle',
  async (): Promise<ThrottlerModuleOptions> => {
    const redisUrl = process.env.REDIS_URL;
    const ttl = Number(process.env.THROTTLE_TTL ?? 60000);
    const limit = Number(process.env.THROTTLE_LIMIT ?? 100);
    const config: ThrottlerModuleOptions = {
      throttlers: [{ ttl, limit }],
    };
    if (redisUrl) {
      const client = createClient({ url: redisUrl });
      await client.connect();
      (config as ThrottlerModuleOptions & { storage?: RedisThrottlerStorage }).storage =
        new RedisThrottlerStorage(client);
    }
    return config;
  },
);