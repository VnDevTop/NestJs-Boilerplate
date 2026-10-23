/**
 * How much work is sitting on one queue.
 *
 * `waiting` is the backlog: the number that grows when the application produces
 * faster than it delivers. `failed` is separate because a queue full of failures
 * and a queue full of undelivered mail are different incidents, and an alert
 * that cannot tell them apart pages somebody for the wrong one.
 *
 * `active` and `delayed` are here so a queue that is *busy* can be told apart
 * from one that is *stuck*: a `waiting` count that never moves with a non-zero
 * `active` is a different problem from one with nothing running at all.
 */
export interface QueueDepth {
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
}

/**
 * The job queue's contract with the rest of the application.
 *
 * Nothing in this file mentions BullMQ, Redis or a timer. That is the whole
 * point: a caller asks for a job to be run, and whether that means an enqueue to
 * Redis or an in-process promise depends on configuration the caller never sees.
 * It is also what makes the in-process fallback a real fallback rather than a
 * second implementation, because both dispatchers hand the payload to the same
 * processor.
 */

export const QUEUE_NAMES = {
  mail: 'mail',
  notification: 'notification',
  maintenance: 'maintenance',
  digest: 'digest',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * What a caller hands to the queue.
 *
 * `payload` is `unknown` deliberately: the processor for a name is the only thing
 * that knows its shape, and a union here would couple every enqueue site to every
 * job type. The processor validates on the way in.
 *
 * No `id`. The queue mints it, so a caller cannot enqueue a job it cannot find
 * again, and the id that ends up in the progress record is the same one the
 * worker reports against.
 */
export interface JobRequest<TPayload = unknown> {
  name: string;
  payload: TPayload;
  /**
   * Identity used by the deduplication guard.
   *
   * Two enqueues with the same key are the same job, so a redelivery or a client
   * retry cannot produce a second email. Left unset by callers that genuinely
   * want every enqueue to run.
   */
  dedupeKey?: string;
}

/**
 * A unit of work, addressed by name and by id.
 *
 * The same shape the caller submitted, plus the id the queue minted for it. The
 * processor sees the id so that its log lines and its progress reports can be
 * tied to one run of one job — a retried job is the same job twice, and the
 * second attempt is a different run of it.
 */
export interface Job<TPayload = unknown> extends JobRequest<TPayload> {
  /** Identifies this run of this job. Minted by the queue. */
  id: string;

  /**
   * The tenant the job is for.
   *
   * **Stamped by the queue, never by the caller.** A job that runs in another
   * process — a worker, a retry an hour later — has no request to read the
   * tenant from, so the tenant travels with the job. And it is stamped rather
   * than passed in because a caller that had to remember it would be the one
   * that forgot it, and a job that writes into the wrong tenant's rows is
   * worse than a job that does not run.
   */
  tenantId: string;
}

/**
 * What the processor returned.
 *
 * `retryable` is the processor's opinion and it matters: a provider that answered
 * 4xx will answer 4xx again, so retrying it only spends the budget and delays the
 * dead-letter entry that would tell an operator something is misconfigured.
 */
export interface JobResult {
  ok: boolean;
  /** Set when the work failed, for the log line and the dead-letter entry. */
  error?: string;
  /**
   * False when the failure is permanent. Defaults to true, so a processor that
   * throws rather than returning is retried, which is the safe default for a
   * transient fault.
   */
  retryable?: boolean;
  /**
   * True when the job stopped because somebody asked it to.
   *
   * Distinct from a failure on purpose. A cancelled job did not break: it was
   * asked to stop and it stopped at the first safe point. So it is neither
   * retried nor dead-lettered — retrying it would do the work nobody wanted
   * done, and dead-lettering it would put an entry in front of an operator that
   * says nothing is wrong.
   */
  cancelled?: boolean;
}

/**
 * Where a job has got to.
 *
 * The states are the ones an operator can act on: a job that is waiting, a job
 * that is running, a job that finished, a job that broke, and a job that was
 * stopped on request. `failed` and `cancelled` are separate because they mean
 * opposite things — one needs attention, the other was asked for.
 */
export type JobStatus =
  'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'replayed';

/**
 * What a job's outcome means for its record.
 *
 * One place, because both dispatchers write the same record and a rule that
 * lived in each of them would drift: the in-process one calling a job "failed"
 * while the bullmq one calls it "completed" is a difference an operator sees as
 * a bug in the wrong place.
 */
export const statusOf = (
  result: JobResult,
): Exclude<JobStatus, 'queued' | 'running' | 'replayed'> => {
  // Checked before the success flag: a job that stopped because it was asked
  // to did not finish, and reporting it as completed would say the work was
  // done when it was not.
  if (result.cancelled === true) {
    return 'cancelled';
  }

  return result.ok ? 'completed' : 'failed';
};

/**
 * What a job reports about how far it has got.
 *
 * `processed` and `total` count the job's own items, not rows and not bytes:
 * what an item is depends on the work, and only the processor knows. `current`
 * names the item in flight, which is the part an operator actually reads — "it is
 * on table 7 of 9" says more than "67%".
 *
 * `total` is null rather than zero when the work does not know its size up
 * front, because zero would be a division by zero in every progress display
 * and a claim that the job has nothing to do.
 */
export interface JobProgressUpdate {
  /** How many items are done. */
  processed?: number;
  /** How many items there are in total, when that is known. */
  total?: number | null;
  /** The item in flight, named the way the job names its items. */
  current?: string | null;
}

/**
 * What a processor is told about the job it is running.
 *
 * The two operations here are the whole of the cancellation story: report how
 * far you have got, and find out whether you should stop. Both are optional in
 * the sense that a processor that ignores the context still works — a mail job
 * has one item and finishes in milliseconds — and both are what turn a
 * five-minute import from a black box into something an operator can watch and
 * stop.
 *
 * Passed in rather than imported, so a processor that wants to report progress
 * does not have to know that redis exists, and so the queue module stays
 * importable from below the processors.
 */
export interface JobContext {
  /** The id of this run of this job. */
  readonly id: string;
  /** The name of this job. */
  readonly name: string;
  /**
   * Reports how far the job has got.
   *
   * Best effort: a report that cannot be stored is dropped rather than failing
   * the job, because the work is the point and the progress is only a report on
   * it.
   */
  report(update: JobProgressUpdate): Promise<void>;
  /**
   * True when somebody asked for this job to stop.
   *
   * Checked at a boundary the job chooses, never inside one. A job that stops
   * halfway through a write leaves the data in a state nobody planned for, so
   * the answer to this question is only useful where stopping is safe.
   */
  isCancelled(): Promise<boolean>;
}

/** How a job should be retried. Mirrors what a queue backend needs. */
export interface RetryPolicy {
  attempts: number;
  backoff: { type: 'exponential'; delay: number };
}

/**
 * The one thing callers use.
 *
 * Both implementations — BullMQ and in-process — satisfy this, so a service
 * injects the token and never branches on which one it got.
 */
export interface JobQueue {
  /** Human-readable name of the active implementation, for the health check. */
  readonly driver: 'bullmq' | 'in-process';
  /**
   * Accepts a job, and resolves once it is accepted rather than once it has run.
   *
   * That distinction is the point: a registration must not wait for SMTP, and an
   * enqueue that resolved on completion would put the provider's latency back into
   * the request.
   *
   * Resolves with the id the job was given, which is the handle the caller uses
   * to watch it and to stop it. The id is minted here rather than by the caller,
   * so a job cannot be enqueued without one and every job can be found again.
   */
  enqueue(queue: QueueName, request: JobRequest): Promise<string>;

  /**
   * Current counts for one queue, or `null` when the implementation cannot answer.
   *
   * `null` rather than zeroes on purpose. The in-process dispatcher knows its own
   * backlog exactly; a BullMQ deployment that cannot reach Redis cannot know, and
   * reporting zero failed jobs because the store is down would turn an outage into
   * a reassuring dashboard. The health check turns `null` into `degraded`.
   */
  depth(queue: QueueName): Promise<QueueDepth | null>;
}
