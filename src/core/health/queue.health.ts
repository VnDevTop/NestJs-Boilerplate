import { Inject, Injectable, Logger } from '@nestjs/common';
import type { HealthIndicatorResult } from '@nestjs/terminus';

import { JOB_QUEUE } from '../../modules/queue/queue.module.js';
import {
  QUEUE_NAMES,
  type JobQueue,
  type QueueDepth,
  type QueueName,
} from '../../modules/queue/queue.interface.js';
import { DeadLetterService } from '../../modules/queue/dead-letter.service.js';
import { RedisClientService } from '../../modules/queue/redis-client.service.js';

/**
 * Jobs wait to be added, so a queue is only ever "behind" in a way a user feels
 * once the backlog is growing.
 *
 * **Above this, the report is `degraded`; below it, `up`.** Neither is `down`,
 * because nothing here stops the application answering requests. A registration
 * with a hundred queued verification mails behind it works — the mail arrives
 * later. What the number buys is that "later" becomes visible before somebody
 * asks where it is.
 *
 * The threshold is a fixed constant rather than a setting. A backlog limit is a
 * statement about what this application can absorb, not a property of the
 * deployment, and a deployment that needs a different one needs to be told rather
 * than handed a knob that quietly disables the alert.
 */
const BACKLOG_THRESHOLD = 1_000;

/** Every queue the policy defines, in the order an operator reads them. */
const QUEUE_NAME_LIST: QueueName[] = Object.values(QUEUE_NAMES);

/**
 * Reports queue connectivity, backlog, and the dead-letter count.
 *
 * ## What is reported, and what is deliberately not
 *
 * `driver` is the first thing in the payload, because "the queue is backed up" and
 * "the queue is the in-process one" are the same symptom from outside and need
 * different answers. A deployment with `QUEUE_ENABLED=false` has no shared
 * backlog at all: every job dies with the process, and a restart loses whatever
 * was waiting. That is visible here rather than discovered.
 *
 * The backlog is reported **per queue**, because the config gives each one its own
 * concurrency and the mail queue being slow is not the same incident as
 * maintenance being slow.
 *
 * ## `degraded`, never `down`
 *
 * A full backlog does not stop the application answering requests; it stops mail
 * arriving. Reporting `down` would take every instance out of rotation over a
 * backlog and turn a delayed email into an outage of the API itself.
 */
@Injectable()
export class QueueHealthIndicator {
  private readonly logger = new Logger(QueueHealthIndicator.name);

  constructor(
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    private readonly deadLetter: DeadLetterService,
    private readonly redis: RedisClientService,
  ) {}

  async isHealthy(): Promise<HealthIndicatorResult> {
    const depths: Record<string, QueueDepth | null> = {};
    const worst = { waiting: 0, queue: null as QueueName | null };

    for (const name of QUEUE_NAME_LIST) {
      const depth = await this.queue.depth(name);

      depths[name] = depth;

      if (depth !== null && depth.waiting > worst.waiting) {
        worst.waiting = depth.waiting;
        worst.queue = name;
      }
    }

    const failedJobs = await this.deadLetter.size();
    const reachable = await this.redisReachable();

    // An unknown backlog is `degraded` even when the numbers look fine, because a
    // dashboard reporting zero waiting jobs while the store is unreachable looks
    // healthier than an application with no jobs at all.
    const unknown = Object.values(depths).some((depth) => depth === null);

    const status =
      unknown ||
      !reachable ||
      worst.waiting > BACKLOG_THRESHOLD ||
      failedJobs > 0
        ? 'degraded'
        : 'up';

    const reasons: string[] = [];

    if (!reachable) {
      reasons.push('redis is unreachable');
    }

    if (unknown) {
      reasons.push('the backlog of at least one queue could not be read');
    }

    if (worst.waiting > BACKLOG_THRESHOLD) {
      reasons.push(
        `the ${worst.queue} backlog is ${worst.waiting}, above ${BACKLOG_THRESHOLD}`,
      );
    }

    if (failedJobs > 0) {
      reasons.push(
        `${failedJobs} job${failedJobs === 1 ? '' : 's'} exhausted their retries`,
      );
    }

    if (reasons.length > 0) {
      this.logger.warn(`Queue health degraded: ${reasons.join('; ')}`);
    }

    return {
      queue: {
        status,
        driver: this.queue.driver,
        reachable,
        backlog: worst.waiting,
        worstQueue: worst.queue,
        deadLettered: failedJobs,
        depths,
        reasons: reasons.length > 0 ? reasons : undefined,
      },
    };
  }

  /**
   * Whether redis answers at all.
   *
   * Only meaningful for BullMQ. The in-process dispatcher keeps its backlog in
   * heap and needs nothing, so a redis outage there costs the throttle counters
   * and the session-revocation record and nothing else — saying `reachable: false`
   * for it would page somebody about a queue that is working.
   */
  private async redisReachable(): Promise<boolean> {
    if (this.queue.driver !== 'bullmq') {
      return true;
    }

    try {
      await this.redis.getClient();

      return true;
    } catch {
      return false;
    }
  }
}
