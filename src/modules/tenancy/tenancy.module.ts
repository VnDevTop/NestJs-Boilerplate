import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TenantContextService } from '../../common/tenancy/tenant-context.service.js';
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
 *
 * **Global, because the context is needed everywhere.** A repository, a cache
 * key and a queued job all have to know whose work they are doing, and a
 * module they each had to import would be a module every one of them had to
 * know about. Global is the same trade the cache and the users module make.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forFeature(tenancyConfig),
    TypeOrmModule.forFeature([Tenant]),
  ],
  providers: [TenantRegistry, TenantContextService],
  exports: [TenantRegistry, TenantContextService],
})
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Applied to every route, and it runs before the guards — a guard that
    // cannot know the tenant cannot decide what the tenant may do.
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
