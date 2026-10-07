import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { queueConfig, type QueueConfig } from '../../configs/queue.config.js';
import { MailModule } from '../mail/index.js';
import { MaintenanceModule } from '../maintenance/index.js';
import { BullMqDispatcher } from './bullmq.dispatcher.js';
import { DeadLetterService } from './dead-letter.service.js';
import { DedupeGuard } from './dedupe.guard.js';
import { InProcessDispatcher } from './in-process.dispatcher.js';
import type { ProcessorRegistry } from './in-process.dispatcher.js';
import { RetentionProcessor } from '../maintenance/processors/retention.processor.js';
import {
  RedisThrottlerStorage,
  THROTTLER_STORAGE,
} from './throttler/redis-throttler.storage.js';
import { MailProcessor } from './processors/mail.processor.js';
import { ProcessorRouter } from './processor-router.service.js';
import type { JobQueue } from './queue.interface.js';
import { RedisClientService } from './redis-client.service.js';

/** The token both drivers are provided under, so a consumer never branches. */
export const JOB_QUEUE = 'JOB_QUEUE';

/** The token the deduplication-wrapped registry is provided under. */
export const PROCESSOR_REGISTRY = 'PROCESSOR_REGISTRY';

const logger = new Logger('QueueModule');

const configOf = (configService: ConfigService): QueueConfig =>
  configService.getOrThrow<QueueConfig>('queue');

/**
 * Background job queue.
 *
 * The config is registered with `forFeature` for the same reason as the mail
 * config: this describes an optional integration, so an app that never queues a
 * job carries none of it.
 *
 * There is deliberately no cron wiring here. The only recurring work is the
 * retention job, which arrives with Phase 16. A `@Cron` entry today would enqueue a
 * job that no processor claims, which the router reports as a permanent failure and
 * the dead-letter list then fills with it every night. When the entries land they
 * will use `@nestjs/schedule` rather than a queue backend, so they keep firing when
 * redis is down — which is when the database most needs cleaning.
 */
@Module({
  imports: [
    ConfigModule.forFeature(queueConfig),
    MailModule,
    MaintenanceModule,
  ],
  providers: [
    MailProcessor,
    RetentionProcessor,
    ProcessorRouter,

    /**
     * The rate limiter's storage, built here because `RedisClientService` is a
     * provider of this module and the connection should be shared rather than a
     * second one opened for counting requests.
     */
    {
      provide: THROTTLER_STORAGE,
      inject: [RedisClientService],
      useFactory: (redis: RedisClientService): RedisThrottlerStorage =>
        new RedisThrottlerStorage(redis),
    },
    RedisClientService,

    /**
     * The registry every dispatcher calls, wrapped in the deduplication guard.
     *
     * The guard sits here rather than inside a dispatcher so both drivers get it.
     * A guard on only one path would mean the duplicate protection applied only
     * when the queue happened to be enabled, which is when it is least likely to
     * be noticed.
     */
    {
      provide: PROCESSOR_REGISTRY,
      inject: [ProcessorRouter, RedisClientService, ConfigService],
      useFactory: (
        router: ProcessorRouter,
        redis: RedisClientService,
        configService: ConfigService,
      ): ProcessorRegistry =>
        new DedupeGuard(router, redis, {
          // The guard's key lifetime is derived from the same retry numbers the
          // drivers use, so the two cannot drift apart.
          backoff: configOf(configService).retry,
        }),
    },

    {
      provide: DeadLetterService,
      inject: [RedisClientService, ConfigService],
      useFactory: (
        redis: RedisClientService,
        configService: ConfigService,
      ): DeadLetterService =>
        new DeadLetterService(redis, configOf(configService).prefix),
    },

    /**
     * The driver is chosen once, here.
     *
     * A deployment with `QUEUE_ENABLED=true` but no `bullmq` installed falls back
     * to the in-process dispatcher instead of failing to boot. That is the whole
     * point of the abstraction, and the misconfiguration is logged loudly because
     * "mail is not being queued" is otherwise invisible until the provider starts
     * rate-limiting a process that is sending everything inline.
     */
    {
      provide: JOB_QUEUE,
      inject: [ConfigService, PROCESSOR_REGISTRY, DeadLetterService],
      useFactory: (
        configService: ConfigService,
        registry: ProcessorRegistry,
        deadLetter: DeadLetterService,
      ): JobQueue => {
        const config = configOf(configService);
        const bullmq = new BullMqDispatcher(configService, registry);

        if (config.enabled && bullmq.isAvailable()) {
          return bullmq;
        }

        if (config.enabled) {
          logger.error(
            'QUEUE_ENABLED is true but bullmq is not installed, so jobs run in ' +
              'this process instead. Install it with: npm install bullmq @nestjs/bullmq',
          );
        }

        return new InProcessDispatcher(
          configService,
          registry,
          config.inProcessFallback ? deadLetter : undefined,
        );
      },
    },
  ],
  exports: [
    JOB_QUEUE,
    PROCESSOR_REGISTRY,
    RedisClientService,
    DeadLetterService,
    THROTTLER_STORAGE,
  ],
})
export class QueueModule {}
