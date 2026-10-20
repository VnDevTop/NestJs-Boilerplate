import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
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
import { JobProgressDto } from './dto/job-progress.dto.js';
import { JobProgressService } from './job-progress.service.js';

/**
 * Watching background work.
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
}
