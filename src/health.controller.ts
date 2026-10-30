import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, MemoryHealthIndicator } from '@nestjs/terminus';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.memory.checkHeap('memory_heap', 200 * 1024 * 1024)]);
  }

  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([() => this.memory.checkHeap('memory_heap', 200 * 1024 * 1024)]);
  }
}