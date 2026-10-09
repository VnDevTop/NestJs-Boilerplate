import { Global, Logger, Module } from '@nestjs/common';
// Aliased because this file also declares a CacheModule of its own.
import { CacheModule as NestCacheModule } from '@nestjs/cache-manager';

import { cacheConfig, type CacheConfig } from '../../configs/index.js';
import { CacheService } from './cache.service.js';
import { createMemoryStore, createRedisStore } from './redis-store.js';

const logger = new Logger('CacheModule');

const onRedisError = (error: Error): void =>
  logger.warn(`Cache unavailable: ${error.message}`);

@Global()
@Module({
  imports: [
    NestCacheModule.registerAsync({
      isGlobal: true,
      ...cacheConfig.asProvider(),
      useFactory: async (config: CacheConfig) => {
        const ttl = config.defaultTtl * 1000;

        if (config.backend === 'memory') {
          return { stores: [createMemoryStore(config)], ttl };
        }

        const store = createRedisStore(config);

        // A Keyv store connects lazily, so this read is what turns an unreachable
        // cache into a failed **boot**. Without it the app would start and then
        // fail on its first request, which is harder to diagnose than not starting.
        // Only the probe wants errors thrown; afterwards a store reports them as
        // misses, which is the fail-open behaviour the rest of this cache needs.
        try {
          await store.get('__startup__');
        } catch (error) {
          onRedisError(error as Error);
          throw error;
        }

        (store as { throwOnErrors: boolean }).throwOnErrors = false;

        return { stores: [store], ttl };
      },
    }),
  ],
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
