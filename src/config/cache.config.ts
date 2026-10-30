import { registerAs } from '@nestjs/config';
import { CacheModuleOptions } from '@nestjs/cache-manager';
import { createKeyv } from '@keyv/redis';

export const cacheConfig = registerAs<CacheModuleOptions>(
  'cache',
  (): CacheModuleOptions => {
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
    } as CacheModuleOptions;
  },
);