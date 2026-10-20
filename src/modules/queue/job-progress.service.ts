import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { QueueConfig } from '../../configs/queue.config.js';
import type {
  Job,
  JobContext,
  JobProgressUpdate,
  JobStatus,
  QueueName,
} from './queue.interface.js';
// A value import, not a type import. The parameter is injected, and a type-only
// import is erased before `design:paramtypes` is emitted, so the parameter
// arrives at Nest as `Object` — which the injector tries to resolve as a
// provider, and the application cannot boot. The same trap `MailProcessor`
// documents for its own optional dependency.
import { RedisClientService } from './redis-client.service.js';

/** One job's progress, as stored and as returned by the route. */
export interface JobProgress {
  /** The id the job was given, and the handle it is found by. */
  id: string;
  /** The job's name, which is what the processor is chosen by. */
  name: string;
  /** The queue the job was put on. */
  queue: QueueName;
  status: JobStatus;
  /** How many items are done. */
  processed: number;
  /** How many items there are in total, when the work knows. */
  total: number | null;
  /** The item in flight. */
  current: string | null;
  /** When a worker picked the job up. */
  startedAt: string | null;
  /** When the job reached a final state. */
  finishedAt: string | null;
  /** Why it failed, when it failed. */
  error: string | null;
}

/**
 * The answer to "what is this job doing", with the store's own health attached.
 *
 * Three answers rather than two, because the third is the one that matters: a
 * store that cannot be reached does not know what the job is doing, and saying
 * "no such job" would tell an operator to stop waiting for a job that is
 * running.
 */
export type JobProgressLookup =
  | { status: 'found'; progress: JobProgress }
  | { status: 'absent' }
  | { status: 'unreachable' };

/**
 * The answer to "please stop this job".
 *
 * Four answers rather than two, because the two that are easy to collapse are
 * the ones that matter: a job that is already finished cannot be stopped, and a
 * store that cannot be reached has not said that there is no job.
 */
export type JobCancelOutcome =
  | { outcome: 'accepted'; status: JobStatus }
  | { outcome: 'finished'; status: JobStatus }
  | { outcome: 'absent' }
  | { outcome: 'unreachable' };

/**
 * Where a job's progress is kept.
 *
 * ## Why redis and not postgres
 *
 * Progress is live operational state about work that is happening now. It is
 * read by a person watching a five-minute import, it is worthless a day later,
 * and nothing else in the application joins against it. A table would mean a
 * schema, a migration, a row per report and a retention rule for a table whose
 * whole content is "how far along was that, and it finished two hours ago".
 *
 * Redis is already here: `RedisClientService` is the queue's own bookkeeping
 * connection, its keys are namespaced away from the cache, and every key it
 * writes can carry a TTL. The TTL is the cleanup: a job's progress is deleted
 * by the store, not by a scheduled job that has to know about every table.
 *
 * ## Why the cancel flag is a separate key
 *
 * The flag is written by one process — the one serving the HTTP route — and the
 * progress is written by another — the worker. If they shared a key, one of
 * them would overwrite the other: a cancel would clobber the progress, and a
 * progress report would clobber the cancel. Two keys, two writers, no lost
 * update.
 *
 * ## Why nothing here is allowed to fail a job
 *
 * A progress store that is down must not stop the work. Every write is
 * best effort and every failure is swallowed, because the alternative is a
 * redis outage turning into a queue that drops mail. The reads say so
 * explicitly, so the route can tell the user rather than guess.
 */
@Injectable()
export class JobProgressService {
  private readonly logger = new Logger(JobProgressService.name);

  constructor(
    private readonly redis: RedisClientService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * How long a job's progress is kept.
   *
   * Read lazily rather than in the constructor: the queue's config namespace is
   * merged into the configuration when the queue module initialises, which is
   * after the providers in it are constructed.
   */
  private get ttlSeconds(): number {
    const ttl = this.configService.getOrThrow<QueueConfig>('queue').progressTtl;

    return Math.max(1, Math.ceil(ttl / 1000));
  }

  private progressKey(id: string): string {
    return `job-progress:${id}`;
  }

  private cancelKey(id: string): string {
    return `job-cancel:${id}`;
  }

  /**
   * Records that a job exists and has not started yet.
   *
   * Written before the job is queued rather than after, because the two
   * writers of this key are the caller and the worker, and the worker's write
   * is the later one. Writing it first is what stops a fast worker from
   * recording "running" and then having it overwritten by "queued" from the
   * process that is still finishing its own enqueue.
   */
  async record(job: Job, queue: QueueName): Promise<void> {
    await this.write(job.id, {
      id: job.id,
      name: job.name,
      queue,
      status: 'queued',
      processed: 0,
      total: null,
      current: null,
      startedAt: null,
      finishedAt: null,
      error: null,
    });
  }

  /** Records that a worker has picked the job up. */
  async markRunning(job: Job): Promise<void> {
    await this.update(job.id, (progress) => ({
      ...progress,
      status: 'running',
      // Kept from the first attempt: a retried job is the same run, and a
      // second "started" would make the duration a lie.
      startedAt: progress.startedAt ?? new Date().toISOString(),
    }));
  }

  /** Records how far the job has got. */
  async report(id: string, update: JobProgressUpdate): Promise<void> {
    await this.update(id, (progress) => ({
      ...progress,
      processed: update.processed ?? progress.processed,
      // `total` and `current` are nullable, so `undefined` is the only way to
      // say "leave it alone". A `??` here would make it impossible to clear a
      // total once it was known.
      total: update.total === undefined ? progress.total : update.total,
      current: update.current === undefined ? progress.current : update.current,
    }));
  }

  /** Records that the job reached a final state. */
  async finish(
    id: string,
    status: Extract<JobStatus, 'completed' | 'failed' | 'cancelled'>,
    error?: string,
  ): Promise<void> {
    await this.update(id, (progress) => ({
      ...progress,
      status,
      finishedAt: new Date().toISOString(),
      error: error ?? progress.error,
    }));
  }

  /** Reads one job's progress, and says whether the store could be reached. */
  async lookup(id: string): Promise<JobProgressLookup> {
    const { value, reachable } = await this.redis.inspect(this.progressKey(id));

    if (!reachable) {
      return { status: 'unreachable' };
    }

    if (value === null) {
      return { status: 'absent' };
    }

    const progress = this.parse(value);

    return progress === null
      ? { status: 'absent' }
      : { status: 'found', progress };
  }

  /**
   * Asks a job to stop.
   *
   * The flag is set rather than the job being killed, because a job can only
   * stop where it is safe to stop. A job that never checks the flag runs to
   * completion, which is the correct outcome for work that cannot be
   * interrupted.
   */
  async requestCancel(id: string): Promise<JobCancelOutcome> {
    const lookup = await this.lookup(id);

    if (lookup.status === 'unreachable') {
      return { outcome: 'unreachable' };
    }

    if (lookup.status === 'absent') {
      return { outcome: 'absent' };
    }

    const { status } = lookup.progress;

    if (status !== 'queued' && status !== 'running') {
      // Already finished, failed or cancelled. There is nothing to stop, and
      // saying so is more useful than a flag nobody will ever read.
      return { outcome: 'finished', status };
    }

    const stored = await this.redis.set(
      this.cancelKey(id),
      '1',
      this.ttlSeconds,
    );

    // `null` means redis could not be asked, which is not the same as the job
    // being absent: the caller is told the store is unreachable so it does not
    // report "no such job".
    return stored === null
      ? { outcome: 'unreachable' }
      : { outcome: 'accepted', status };
  }

  /** True when somebody asked this job to stop. */
  async isCancelled(id: string): Promise<boolean> {
    const { value } = await this.redis.inspect(this.cancelKey(id));

    return value !== null;
  }

  /**
   * Removes the record of a job that is not going to run.
   *
   * Used when the enqueue itself failed: the record was written first so the
   * worker could not overwrite it, and a job that never reached the queue must
   * not leave a record behind that says it is waiting.
   */
  async forget(id: string): Promise<void> {
    await this.redis.delete(this.progressKey(id));
    await this.redis.delete(this.cancelKey(id));
  }

  /**
   * The context handed to a processor.
   *
   * Built here rather than by the dispatcher so that both drivers give the
   * processor the same thing, and so the processor never learns that the
   * progress is kept in redis.
   */
  context(job: Job): JobContext {
    return {
      id: job.id,
      name: job.name,
      report: (update) => this.report(job.id, update),
      isCancelled: () => this.isCancelled(job.id),
    };
  }

  /**
   * Reads the stored record, changes it and writes it back.
   *
   * A read-modify-write, which is safe here because only the worker writes
   * this key: the caller writes it once at enqueue and the worker takes it over
   * from there. The cancel flag is a separate key precisely so it does not
   * take part in this.
   */
  private async update(
    id: string,
    mutate: (progress: JobProgress) => JobProgress,
  ): Promise<void> {
    const { value } = await this.redis.inspect(this.progressKey(id));

    if (value === null) {
      // Absent, or the store is unreachable. Either way there is nothing to
      // change, and the write that would follow would create a record of a job
      // whose enqueue never happened.
      return;
    }

    const progress = this.parse(value);

    if (progress === null) {
      return;
    }

    await this.write(id, mutate(progress));
  }

  /**
   * Writes the record.
   *
   * Failures are swallowed. The redis client has already logged the underlying
   * problem, and a progress store that is down must not stop the work — the
   * alternative is a redis outage turning into a queue that drops mail.
   */
  private async write(id: string, progress: JobProgress): Promise<void> {
    const stored = await this.redis.set(
      this.progressKey(id),
      JSON.stringify(progress),
      this.ttlSeconds,
    );

    if (stored === null) {
      this.logger.warn(
        `Could not record the progress of job ${id}. The work continues; the ` +
          'progress is not visible until the store is back.',
      );
    }
  }

  /** Parses a stored record, treating anything unreadable as absent. */
  private parse(value: string): JobProgress | null {
    try {
      const parsed = JSON.parse(value) as Partial<JobProgress>;

      if (typeof parsed.id !== 'string' || typeof parsed.name !== 'string') {
        return null;
      }

      return {
        id: parsed.id,
        name: parsed.name,
        queue: parsed.queue ?? 'mail',
        status: parsed.status ?? 'queued',
        processed: parsed.processed ?? 0,
        total: parsed.total ?? null,
        current: parsed.current ?? null,
        startedAt: parsed.startedAt ?? null,
        finishedAt: parsed.finishedAt ?? null,
        error: parsed.error ?? null,
      };
    } catch {
      return null;
    }
  }
}
