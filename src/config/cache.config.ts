import { registerAs } from '@nestjs/config';
import { CacheModuleOptions } from '@nestjs/cache-manager';
import { createKeyv } from '@keyv/redis';

export interface CacheConfig extends CacheModuleOptions {
  redisUrl?: string;
  keyPrefix: string;
}

export const cacheConfig = registerAs<CacheConfig>(
  'cache',
  (): CacheConfig => {
    const redisUrl = process.env.REDIS_URL;
    const keyPrefix = 'cache:';
    return {
      ttl: Number(process.env.CACHE_TTL ?? 60000),
      namespace: 'cache',
      keyPrefix,
      redisUrl,
      stores: redisUrl
        ? createKeyv(redisUrl, { namespace: keyPrefix.replace(':', '') })
        : undefined,
    };
  },
);