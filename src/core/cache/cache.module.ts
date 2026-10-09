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

        const { store } = await createRedisStore(config, onRedisError, {
          probe: true,
        });

        return { stores: [store], ttl };
      },
    }),
  ],
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
