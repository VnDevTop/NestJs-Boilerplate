import { Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import {
  ManagerOnly,
  Permissions,
  Roles,
} from '../../common/decorators/index.js';
import { Permission, Role } from '../../common/enums/index.js';
import { RetentionTrigger } from '../maintenance/entities/retention-trigger.enum.js';
import {
  RetentionQueuedDto,
  RetentionRunDto,
} from '../maintenance/dto/index.js';
import { JOB_QUEUE } from '../queue/queue.tokens.js';
import { QUEUE_NAMES, type JobQueue } from '../queue/queue.interface.js';
import {
  RETENTION_JOB,
  type RetentionJobPayload,
} from '../maintenance/processors/retention.processor.js';
import { RetentionService } from '../maintenance/retention.service.js';
import {
  CursorPaginationQueryDto,
  PaginatedResultDto,
} from '../../common/pagination/index.js';
import { MaintenanceLog } from '../maintenance/entities/maintenance-log.entity.js';

/**
 * Retention controls.
 *
 * In the admin module rather than beside the retention code because that is where
 * the operator already looks, and because the two routes that change data need a
 * stronger role than the read routes next to them: `ManagerOnly` on this class
 * would apply to both, and a manager should be able to read the history without
 * being able to delete every user in the database.
 *
 * The path is `admin/retention` while the code lives in `maintenance`, which is
 * what keeps the import graph one-directional: this controller needs `JOB_QUEUE`,
 * so it cannot live in `MaintenanceModule`, which `QueueModule` imports.
 */
@ApiTags('Admin Retention')
@ApiBearerAuth('access-token')
@Controller('admin/retention')
export class AdminRetentionController {
  constructor(
    private readonly retentionService: RetentionService,
    @Inject(JOB_QUEUE)
    private readonly queue: JobQueue,
  ) {}

  /**
   * Counts what a real run would delete, and deletes nothing.
   *
   * Deliberately synchronous even though the queued job is not: counting is fast
   * enough to answer inside a request, and an operator rehearsing against
   * production data wants the numbers now, not after polling the history. The
   * count is exact, with no cap, because a rehearsal that under-reports is worse
   * than a slow one.
   */
  @Roles(Role.Admin, Role.SuperAdmin)
  @Permissions(Permission.MaintenanceRun)
  @Post('dry-run')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Report what a retention run would delete, without deleting it',
  })
  @ApiOkResponse({ type: RetentionRunDto })
  async dryRun(): Promise<RetentionRunDto> {
    const result = await this.retentionService.run({ dryRun: true });

    // Recorded like any other run. A rehearsal that left no trace could not be
    // distinguished from one that never happened. The response is built from the
    // row that was written, so the id it carries is a real one.
    const entry = await this.retentionService.record(
      result,
      RetentionTrigger.Admin,
    );

    return AdminRetentionController.toLogDto(entry);
  }

  /**
   * Queues a real run and returns immediately.
   *
   * A real run deletes in batches with a pause between them, so it can take
   * minutes: far longer than a request should hold open. Queuing it also means the
   * operator gets the same execution path as the nightly schedule, rather than a
   * second one that only the HTTP route uses.
   */
  @Roles(Role.Admin, Role.SuperAdmin)
  @Permissions(Permission.MaintenanceRun)
  @Post('run')
  @HttpCode(202)
  @ApiOperation({ summary: 'Queue a retention run' })
  @ApiOkResponse({ type: RetentionQueuedDto })
  async run(): Promise<RetentionQueuedDto> {
    const payload: RetentionJobPayload = { trigger: RetentionTrigger.Admin };

    await this.queue.enqueue(QUEUE_NAMES.maintenance, {
      name: RETENTION_JOB,
      payload,
    });

    return { queued: true, see: '/admin/retention/runs/latest' };
  }

  /**
   * One page of the retention run history, newest first.
   *
   * **Cursor paged like every other listing.** The `limit`/`offset` pair it used to
   * take was hand-rolled and local — two private helpers clamping a string, which
   * is the pattern that produces a fourth route with a subtly different rule for
   * what an oversized `limit` means. One implementation, one rule.
   *
   * **The `total` is gone.** See `RetentionService.history`: counting the history
   * meant reading every run ever recorded, on the route an operator opens when
   * something has already gone wrong. `meta.hasMore` answers the only question the
   * screen actually asks.
   */
  @ManagerOnly()
  @Get('runs')
  @ApiOperation({
    summary: 'Read a page of the retention run history',
    description:
      'Cursor paged. Pass `meta.nextCursor` back as `cursor` for the next page.',
  })
  @ApiOkResponse({ type: RetentionRunDto, isArray: true })
  async history(
    @Query() query: CursorPaginationQueryDto,
  ): Promise<PaginatedResultDto<RetentionRunDto>> {
    const page = await this.retentionService.history(query);

    return PaginatedResultDto.of(
      page.items.map(AdminRetentionController.toLogDto),
      page.meta,
    );
  }

  /**
   * The most recent run, or null when nothing has ever run.
   *
   * Null rather than an empty object, because an app whose retention was only just
   * enabled has genuinely never run it, and a response that looked like a run with
   * zeroes in it would read as a run that found nothing.
   */
  @ManagerOnly()
  @Get('runs/latest')
  @ApiOperation({ summary: 'Read the most recent retention run' })
  @ApiOkResponse({ type: RetentionRunDto })
  async latest(): Promise<RetentionRunDto | null> {
    const entry = await this.retentionService.latest();

    return entry === null ? null : AdminRetentionController.toLogDto(entry);
  }

  private static toLogDto(entry: MaintenanceLog): RetentionRunDto {
    return {
      id: entry.id,
      startedAt: entry.startedAt.toISOString(),
      finishedAt: entry.finishedAt.toISOString(),
      durationMs: entry.durationMs,
      dryRun: entry.dryRun,
      totalDeleted: entry.totalDeleted,
      timedOut: entry.timedOut,
      trigger: entry.trigger,
      // Spread, because the service types both as readonly and the DTO promises
      // a mutable array to whoever consumes it.
      pending: [...entry.pending],
      failedTargets: [...entry.failedTargets],
      targets: entry.targets.map((target) => ({
        ...target,
        cascades: [...target.cascades],
      })),
    };
  }
}
