import { Controller, Get, Module, NotFoundException } from '@nestjs/common';
import {
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { Public } from '../../common/decorators/index.js';
import { MetricsService } from './metrics.service.js';

@ApiTags('Operations')
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'Prometheus metrics',
    description:
      'Returns 404 when prom-client is not installed. Metrics are a ' +
      'deployment feature, not a runtime dependency.',
  })
  @ApiOkResponse({ description: 'The exposition format' })
  @ApiExcludeEndpoint()
  async scrape(): Promise<string> {
    const scraped = await this.metrics.scrape();

    if (scraped === null) {
      throw new NotFoundException(
        'Metrics are not enabled. Install prom-client and restart: ' +
          'npm install prom-client',
      );
    }

    return scraped.body;
  }
}

@Module({
  providers: [MetricsService],
  controllers: [MetricsController],
  exports: [MetricsService],
})
export class MetricsModule {}
