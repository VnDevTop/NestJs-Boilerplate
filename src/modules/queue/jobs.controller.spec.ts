import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { describe, expect, it } from 'vitest';

import { JobsController } from './jobs.controller.js';
import type {
  JobProgress,
  JobProgressLookup,
  JobProgressService,
} from './job-progress.service.js';

const id = '11111111-1111-4111-8111-111111111111';

const progress: JobProgress = {
  id,
  name: 'maintenance.run-retention',
  queue: 'maintenance',
  status: 'running',
  processed: 4,
  total: 9,
  current: 'notification_logs',
  startedAt: '2026-10-20T09:12:03.000Z',
  finishedAt: null,
  error: null,
};

function build(
  lookup: JobProgressLookup,
  cancelRequested = false,
): JobsController {
  const service = {
    lookup: async () => lookup,
    isCancelled: async () => cancelRequested,
  } as unknown as JobProgressService;

  return new JobsController(service);
}

describe('JobsController.read', () => {
  it('returns what the job is doing', async () => {
    const controller = build({ status: 'found', progress });

    await expect(controller.read(id)).resolves.toEqual({
      ...progress,
      cancelRequested: false,
    });
  });

  it('says whether somebody asked the job to stop', async () => {
    const controller = build({ status: 'found', progress }, true);

    const result = await controller.read(id);

    expect(result.cancelRequested).toBe(true);
  });

  it('answers 404 for a job it has never heard of', async () => {
    const controller = build({ status: 'absent' });

    await expect(controller.read(id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers 503 when the store cannot be reached', async () => {
    const controller = build({ status: 'unreachable' });

    // Not a 404. The store being down says nothing about whether the job
    // exists, and an operator told "no such job" would stop waiting for a job
    // that is running.
    await expect(controller.read(id)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
