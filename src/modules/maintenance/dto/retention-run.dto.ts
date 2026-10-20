import { ApiProperty } from '@nestjs/swagger';

import { RetentionTrigger } from '../entities/retention-trigger.enum.js';

/** Per-target outcome, as stored in the history and returned by a run. */
export class RetentionTargetResultDto {
  @ApiProperty({ example: 'users' })
  id!: string;

  @ApiProperty({ example: 'users' })
  table!: string;

  @ApiProperty({
    example: 'soft-deleted users, hard deleted once the grace period passes',
  })
  description!: string;

  @ApiProperty({ example: 30 })
  ageDays!: number;

  @ApiProperty({
    description: 'Rows deleted, or rows a dry run would delete',
    example: 40,
  })
  deleted!: number;

  @ApiProperty({ example: 2 })
  batches!: number;

  @ApiProperty({ example: 812 })
  durationMs!: number;

  @ApiProperty({ type: [String], example: ['refresh_tokens'] })
  cascades!: string[];

  @ApiProperty({
    required: false,
    description: 'Set when this target failed. The run continues past it.',
    example: 'column "revokedAt" does not exist',
  })
  error?: string;
}

/** One recorded run. */
export class RetentionRunDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '2026-10-03T03:17:00.000Z' })
  startedAt!: string;

  @ApiProperty({ example: '2026-10-03T03:17:01.234Z' })
  finishedAt!: string;

  @ApiProperty({ example: 1234 })
  durationMs!: number;

  @ApiProperty({ description: 'True when nothing was deleted', example: false })
  dryRun!: boolean;

  @ApiProperty({ example: 42 })
  totalDeleted!: number;

  @ApiProperty({
    description:
      'True when the run stopped on its timeout with tables still unclean',
    example: false,
  })
  timedOut!: boolean;

  @ApiProperty({ enum: RetentionTrigger, example: RetentionTrigger.Cron })
  trigger!: RetentionTrigger;

  @ApiProperty({ type: [String], example: [] })
  pending!: string[];

  @ApiProperty({ type: [String], example: [] })
  failedTargets!: string[];

  @ApiProperty({ type: [RetentionTargetResultDto] })
  targets!: RetentionTargetResultDto[];
}

/**
 * A page of history.
 *
 * **Deleted rather than kept as `{ items, total }`.** The route now returns the
 * shared `PaginatedResultDto`, whose `meta` carries `nextCursor` and `hasMore`
 * instead of a total. The total was a `COUNT(*)` over a table nothing prunes, on
 * the screen an operator opens when something has already gone wrong.
 */

/** Returned by the route that queues a run rather than performing it. */
export class RetentionQueuedDto {
  @ApiProperty({ example: true })
  queued!: boolean;

  @ApiProperty({
    format: 'uuid',
    description:
      'The id of the queued job. It is the handle the run is watched with: ' +
      'the history says what happened, the job says what is happening now.',
    example: '11111111-1111-4111-8111-111111111111',
  })
  jobId!: string;

  @ApiProperty({
    description:
      'Where to look for the outcome. The run happens in the queue, not in this ' +
      'request, so the answer arrives in the history rather than in this response.',
    example: '/admin/retention/runs/latest',
  })
  see!: string;
}
