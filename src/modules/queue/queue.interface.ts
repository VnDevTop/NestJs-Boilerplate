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
 * A unit of work, addressed by name.
 *
 * `payload` is `unknown` deliberately: the processor for a name is the only thing
 * that knows its shape, and a union here would couple every enqueue site to every
 * job type. The processor validates on the way in.
 */
export interface Job<TPayload = unknown> {
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
   */
  enqueue(queue: QueueName, job: Job): Promise<void>;

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
