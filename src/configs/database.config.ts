import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { TypeOrmTracingLogger } from '../core/tracing/index.js';

export const databaseConfig = registerAs(
  'database',
  (): TypeOrmModuleOptions => ({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    autoLoadEntities: true,
    //synchronize: true,
    /**
     * `logger`, not `logging`.
     *
     * TypeORM's `logging` option only accepts `boolean | 'all' | LogLevel[]`; a
     * logger *instance* goes on `logger`, and passing one to `logging` is a type
     * error rather than a runtime one. This logger forwards `info` and `error` to
     * Nest's own logger, so the console output a deployment had before is
     * unchanged — an operator who loses their query errors because a tracing
     * library was installed has been made worse by an observability feature.
     *
     * `maxQueryExecutionTime` is what makes `logQuerySlow` fire for the statements
     * worth explaining and nothing else. A span per query would turn a burst of
     * traffic into a burst of tracing traffic, and the sampler would then drop
     * almost everything — including the query somebody was looking for.
     */
    logger: new TypeOrmTracingLogger(),
    maxQueryExecutionTime: 200,
    ssl:
      process.env.DATABASE_SSL === 'false'
        ? false
        : { rejectUnauthorized: false },
    extra: {
      ssl:
        process.env.DATABASE_SSL === 'false'
          ? false
          : { rejectUnauthorized: false },
    },
  }),
);
