import { ApiProperty } from '@nestjs/swagger';

import type { JobStatus } from '../queue.interface.js';

/**
 * What a job is doing right now.
 *
 * The shape an operator actually reads: where the job is, how far it has got,
 * what it is working on, and why it stopped. `total` is null when the work did
 * not know its size up front, which is a different answer from zero.
 */
export class JobProgressDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'maintenance.run-retention' })
  name!: string;

  @ApiProperty({ example: 'maintenance' })
  queue!: string;

  @ApiProperty({
    enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
    example: 'running',
  })
  status!: JobStatus;

  @ApiProperty({
    description: "How many items are done. Counted in the job's own items.",
    example: 4,
  })
  processed!: number;

  @ApiProperty({
    description:
      'How many items there are in total, when the work knows. Null when it ' +
      'does not, which is not the same as zero.',
    nullable: true,
    example: 9,
  })
  total!: number | null;

  @ApiProperty({
    description: 'The item in flight, named the way the job names its items.',
    nullable: true,
    example: 'notification_logs',
  })
  current!: string | null;

  @ApiProperty({
    description: 'When a worker picked the job up.',
    nullable: true,
    example: '2026-10-20T09:12:03.000Z',
  })
  startedAt!: string | null;

  @ApiProperty({
    description: 'When the job reached a final state.',
    nullable: true,
    example: null,
  })
  finishedAt!: string | null;

  @ApiProperty({
    description: 'Why it failed, when it failed.',
    nullable: true,
    example: null,
  })
  error!: string | null;

  @ApiProperty({
    description:
      'True when somebody asked for this job to stop. The job keeps running ' +
      'until it reaches a point where stopping is safe.',
    example: false,
  })
  cancelRequested!: boolean;
}
