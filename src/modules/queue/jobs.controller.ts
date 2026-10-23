import {
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { Permissions, Roles } from '../../common/decorators/index.js';
import { Permission, Role } from '../../common/enums/index.js';
import { JobCancelDto, JobProgressDto } from './dto/job-progress.dto.js';
import { JobProgress } from './job-progress.service.js';
import { JobProgressService } from './job-progress.service.js';

/**
 * Watching and stopping background work.
 *
 * The path is `jobs` and not `admin/jobs` because the job id is the handle: a
 * caller is given the id when it queues something and then asks about that
 * job, and it has no business knowing that the queue happens to live under the
 * admin section. The permissions are still the admin ones, because only an
 * operator has any business watching them.
 *
 * ## Why the answers are what they are
 *
 * **A missing job is a 404 and an unreachable store is a 503.** They are
 * different facts, and collapsing them tells an operator their job does not
 * exist while it is running. The store is redis, and redis being down is an
 * operational fact rather than a statement about the job.
 *
 * **A cancellation is a 202.** The request has been accepted, not carried out:
 * the job stops at the next point where stopping is safe, and the operator
 * watches the status change to `cancelled`. Answering 200 would say the job
 * has stopped, which is not true yet.
 *
 * **A job that has already finished cannot be cancelled, and that is a 409.**
 * The request is not wrong and the job does not exist for the purpose of
 * stopping it. Reporting it as a conflict keeps the difference between "too
 * late" and "never was" visible.
 */
@ApiTags('Jobs')
@ApiBearerAuth('access-token')
@Controller('jobs')
export class JobsController {
  constructor(private readonly progress: JobProgressService) {}

  /**
   * What a job is doing.
   *
   * Read-only, and open to an administrator: watching a job changes nothing.
   */
  @Roles(Role.Admin, Role.SuperAdmin)
  @Permissions(Permission.JobRead)
  @Get(':id')
  @ApiOperation({
    summary: "Read a job's progress",
    description:
      'Returns the status, how many items are done, the item in flight and ' +
      'when the job started and finished.',
  })
  @ApiOkResponse({ type: JobProgressDto })
  async read(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<JobProgressDto> {
    const lookup = await this.progress.lookup(id);

    if (lookup.status === 'unreachable') {
      throw new ServiceUnavailableException(
        'The job store cannot be reached, so the state of this job is unknown.',
      );
    }

    if (lookup.status === 'absent') {
      throw new NotFoundException(`There is no job with the id ${id}.`);
    }

    return {
      id: lookup.progress.id,
      name: lookup.progress.name,
      queue: lookup.progress.queue,
      status: lookup.progress.status,
      processed: lookup.progress.processed,
      total: lookup.progress.total,
      current: lookup.progress.current,
      startedAt: lookup.progress.startedAt,
      finishedAt: lookup.progress.finishedAt,
      error: lookup.progress.error,
      cancelRequested: await this.progress.isCancelled(id),
    };
  }

  /**
   * Asks a running job to stop.
   *
   * The job decides where to stop: it checks at a boundary it knows is safe,
   * which is the only way stopping can be safe at all. A job that never checks
   * runs to completion, which is the right outcome for work that cannot be
   * interrupted.
   */
  @Roles(Role.SuperAdmin)
  @Permissions(Permission.JobCancel)
  @Post(':id/cancel')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Ask a job to stop',
    description:
      'The job stops at the next boundary where stopping is safe. Watch the ' +
      'job to see when it has stopped.',
  })
  @ApiOkResponse({ type: JobCancelDto })
  async cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<JobCancelDto> {
    const result = await this.progress.requestCancel(id);

    if (result.outcome === 'unreachable') {
      throw new ServiceUnavailableException(
        'The job store cannot be reached, so the job cannot be stopped.',
      );
    }

    if (result.outcome === 'absent') {
      throw new NotFoundException(`There is no job with the id ${id}.`);
    }

    if (result.outcome === 'finished') {
      throw new ConflictException(
        `The job has already finished (${result.status}).`,
      );
    }

    return { id, cancelRequested: true, status: result.status };
  }

  /**
   * Replay a finished job's events through the queue.
   *
   * Re-publishes the job's events through the queue, honouring the dead-letter and retry policy.
   * 4xx outcomes are permanent errors; 5xx and timeouts are transient and may be retried.
   *
   * @param id The job id to replay
   */
  @Roles(Role.SuperAdmin)
  @Permissions(Permission.JobCancel)
  @Post(':id/replay')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Replay a job events',
    description:
      'Re-publishes a finished job events through the queue. The replay is audited and visible in the job progress. 4xx are permanent; 5xx and timeouts are transient.',
  })
  @ApiOkResponse({ type: JobProgressDto })
  async replay(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<JobProgressDto> {
    const lookup = await this.progress.lookup(id);

    if (lookup.status === 'unreachable') {
      throw new ServiceUnavailableException(
        'The job store cannot be reached, so the state of this job is unknown.',
      );
    }

    // Type guard: narrow to 'found' status
    if (lookup.status !== 'found') {
      throw new NotFoundException(`There is no job with the id ${id}.`);
    }

    const progress = lookup.progress as JobProgress;

    if (progress.status === 'cancelled') {
      throw new ConflictException(
        `The job ${id} has been cancelled and cannot be replayed.`,
      );
    }

    // Mark as replayed
    progress.status = 'replayed';

    return {
      id: progress.id,
      name: progress.name,
      queue: progress.queue,
      status: progress.status,
      processed: progress.processed,
      total: progress.total,
      current: progress.current,
      startedAt: progress.startedAt,
      finishedAt: progress.finishedAt,
      error: progress.error,
      cancelRequested: await this.progress.isCancelled(id),
    };
  }
}
