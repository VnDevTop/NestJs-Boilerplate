import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { tenancyConfig } from '../../configs/tenancy.config.js';
import { Tenant } from './entities/tenant.entity.js';
import { TenantMiddleware } from './tenant.middleware.js';
import { TenantRegistry } from './tenant-registry.service.js';

/**
 * Which tenant a request is for.
 *
 * **Its own module, and it is at the root.** The tenant decides what a request
 * may see, so it has to be resolved before anything else runs — and a module
 * that every other module depends on is a module that cannot be below any of
 * them.
 */
@Module({
  imports: [
    ConfigModule.forFeature(tenancyConfig),
    TypeOrmModule.forFeature([Tenant]),
  ],
  providers: [TenantRegistry],
  exports: [TenantRegistry],
})
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Applied to every route, and it runs before the guards — a guard that
    // cannot know the tenant cannot decide what the tenant may do.
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
