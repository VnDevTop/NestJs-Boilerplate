import {
  Controller,
  Get,
  Module,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  TerminusModule,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';

import { Public } from '../../common/decorators/index.js';
import { MailModule } from '../../modules/mail/mail.module.js';
import { QueueModule } from '../../modules/queue/queue.module.js';
import { MetricsModule } from '../metrics/index.js';
import { MaintenanceModule } from '../../modules/maintenance/maintenance.module.js';
import { CacheHealthIndicator } from './cache.health.js';
import { MaintenanceHealthIndicator } from './maintenance.health.js';
import { MailHealthIndicator } from './mail.health.js';
import { QueueHealthIndicator } from './queue.health.js';
import { ShutdownService } from './shutdown.service.js';

/**
 * Liveness and readiness are separate on purpose. Liveness must stay green while
 * a dependency is down, because a failing liveness probe makes an orchestrator
 * restart every healthy instance at exactly the wrong moment. Readiness is the
 * one that goes red, so traffic is diverted without a restart.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: TypeOrmHealthIndicator,
    private readonly cache: CacheHealthIndicator,
    private readonly mail: MailHealthIndicator,
    private readonly queue: QueueHealthIndicator,
    private readonly maintenance: MaintenanceHealthIndicator,
    private readonly shutdown: ShutdownService,
  ) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok', uptime: process.uptime() };
  }

  @Public()
  @Get('ready')
  @HealthCheck()
  ready() {
    if (this.shutdown.isShuttingDown) {
      throw new ServiceUnavailableException('Shutting down');
    }

    return this.health.check([
      () => this.database.pingCheck('database'),
      () => this.cache.isHealthy(),
      () => this.mail.isHealthy(),
      () => this.queue.isHealthy(),
      () => this.maintenance.isHealthy(),
    ]);
  }

  @Public()
  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.database.pingCheck('database'),
      () => this.cache.isHealthy(),
      () => this.mail.isHealthy(),
      () => this.queue.isHealthy(),
      () => this.maintenance.isHealthy(),
    ]);
  }
}

@Module({
  // `QueueModule` for the dispatcher, the dead-letter list and the redis client
  // the backlog is read through; `MailModule` for the transport; `MetricsModule`
  // for the counters the indicators record into. All three are one direction only
  // — none of them imports the health module — so nothing here can close a cycle
  // through the indicator.
  //
  // Each is imported for a provider this module *injects*. `AppModule` importing
  // the same modules makes them available to `AppModule`, which is a different
  // question from whether they are available here, and importing one at the root
  // is what made every indicator a boot-time failure until each import was added.
  imports: [
    TerminusModule,
    MailModule,
    QueueModule,
    MaintenanceModule,
    MetricsModule,
  ],
  controllers: [HealthController],
  providers: [
    CacheHealthIndicator,
    MailHealthIndicator,
    QueueHealthIndicator,
    MaintenanceHealthIndicator,
    ShutdownService,
  ],
  exports: [ShutdownService],
})
export class HealthModule {}
