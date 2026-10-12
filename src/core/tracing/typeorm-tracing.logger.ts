import { Injectable, Logger } from '@nestjs/common';
import type { Logger as TypeOrmLogger } from 'typeorm';

import { TracingService } from './tracing.service.js';

/**
 * Spans for the queries that are slow or that failed.
 *
 * ## Not every query
 *
 * TypeORM calls `logQuery` for every statement, and a span per statement turns a
 * burst of traffic into a burst of tracing traffic. The sampler then gets
 * configured to drop almost everything, and the result is that the one slow query
 * you wanted is the one that got dropped.
 *
 * `logQuerySlow` is the hook that already knows the duration, so nothing is timed
 * twice: TypeORM calls it when a statement exceeds `maxQueryExecutionTime`, which
 * `database.config.ts` sets. Instrumenting there means the span exists exactly for
 * the statements worth explaining.
 *
 * ## The query text goes in, the parameters do not
 *
 **Parameters are where a password hash, an address and a reset token all live.**
 * A span carrying them is a span in a tracing backend, which is a different store
 * with a different retention policy to the database and usually a much longer one.
 * The SQL is safe — it is the query, and it has no row in it — so the text is what
 * makes the span useful.
 *
 * ## Nothing here ever throws
 *
 * A logger that throws takes the query down with it. Every method is a single
 * guarded call, because this runs inside the database path where a failure would
 * look like a database failure.
 */
@Injectable()
export class TypeOrmTracingLogger implements TypeOrmLogger {
  private readonly logger = new Logger(TypeOrmTracingLogger.name);

  /**
   * `TracingService` has a default so this can be constructed from a plain config
   * object, the way `database.config.ts` builds it. Nest injects the real one when
   * it builds the provider itself; the config path is the one that cannot, and it
   * gets the same no-op tracing a deployment without the API package gets.
   */
  constructor(
    private readonly tracing: TracingService = new TracingService(),
  ) {}

  /**
   * A statement over `maxQueryExecutionTime`.
   *
   * The duration is recorded as the span's own duration rather than as an
   * attribute, because that is what `histogram_quantile` over
   * `db.query.duration` is for and a reader expects the unit to be seconds.
   */
  /**
   * TypeORM's own signature, kept whole even though two parameters are unused.
   *
   * Dropping them would make the method *narrower* than the interface, which is
   * allowed — and which is exactly how a secret in `parameters` reaches a span the
   * next time somebody widens the signature to "log everything".
   */
  logQuerySlow(
    time: number,
    query: string,
    _parameters?: unknown,
    _queryRunner?: unknown,
  ): void {
    this.guard(() => {
      const span = this.tracing.startSpan('db.query', {
        'db.system': 'postgresql',
        'db.statement': query,
      });

      try {
        span.setStatus({ code: 0, message: `${time}ms` });
      } finally {
        span.end();
      }
    });
  }

  /**
   * A statement that failed.
   *
   * A fresh span rather than an attribute on the caller's: TypeORM hands the error
   * over outside any context this module controls, and guessing at a parent would
   * attach a database failure to whichever request happened to be running. A span
   * with no parent is an orphan that still says the query and the error.
   */
  logQueryError(
    error: string | Error,
    query: string,
    _parameters?: unknown,
    _queryRunner?: unknown,
  ): void {
    // Forwarded as well as traced. This logger *replaces* `logging: ['error']` in
    // the TypeORM options rather than adding to it, and an operator who loses
    // their query errors because a tracing library was installed has been made
    // worse by an observability feature.
    this.guard(() =>
      this.logger.error(
        `Query failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        query,
      ),
    );

    this.guard(() => {
      const span = this.tracing.startSpan('db.query.failed', {
        'db.system': 'postgresql',
        'db.statement': query,
      });

      try {
        span.recordException(error);
        span.setStatus({
          code: this.tracing.errorCode(),
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        span.end();
      }
    });
  }

  logQuery(
    _query: string,
    _parameters?: unknown,
    _queryRunner?: unknown,
  ): void {
    // Every statement, not only the slow ones. See the class comment.
  }

  logSchemaBuild(_message: string, _queryRunner?: unknown): void {
    // Happens once, at boot, before anything is being traced.
  }

  logMigration(_message: string, _queryRunner?: unknown): void {
    // A deploy is not a hot path, and a span per migration statement is noise in a
    // backend nobody queries for a week afterwards.
  }

  log(
    level: 'log' | 'info' | 'warn',
    message: string,
    _queryRunner?: unknown,
  ): void {
    // Forwarded, and deliberately not traced. This is the `logging: ['info']` half
    // of the previous configuration — "Executing (default): SELECT …" — and a
    // span per statement is exactly the traffic this class exists to avoid. The
    // console output is unchanged for anybody who had it before.
    // Routed to the level TypeORM asked for rather than flattened to `log`, so
    // `['error']` and `['warn']` keep meaning what they meant. A switch rather
    // than an index: TypeORM's union does not include every `Logger` method, so
    // `this.logger[level]` is not typeable without narrowing.
    this.guard(() => {
      if (level === 'warn') {
        this.logger.warn(message);

        return;
      }

      this.logger.log(message);
    });
  }

  private guard(work: () => void): void {
    try {
      work();
    } catch {
      // Nothing is logged from inside here. This runs in the database path, and a
      // tracing failure that turned into a log line on every query would be the
      // outage this module exists to help diagnose.
    }
  }
}
