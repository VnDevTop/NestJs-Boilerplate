import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import type { Writable } from 'node:stream';

import { getRequestId } from '../../common/utils/index.js';
import { redactForLog, redactText } from '../redact/index.js';
import { TracingService } from '../tracing/index.js';

export interface AppLoggerOptions {
  levels: LogLevel[];
  stream: Writable;
}

interface LogEntry {
  level: LogLevel;
  context?: string;
  message: unknown;
  requestId?: string;
  traceId?: string;
}

/**
 * Emits one JSON object per line, so a log shipper can parse it without a
 * regex.
 *
 * This is only used in production. Development keeps Nest's own logger, whose
 * coloured output includes the per module load time, and that number is worth
 * more than consistency while you are working. Two formats for two audiences
 * beats one format for neither.
 *
 * The request id is read from the async context rather than passed in, so a log
 * written deep inside a service is correlatable without the call site knowing
 * anything about requests.
 */
export class AppLogger extends ConsoleLogger {
  private readonly settings: AppLoggerOptions;

  /**
   * A process-wide tracing service, read for every line.
   *
   * Not injected: the logger is constructed before the Nest container exists —
   * `createAppLogger` is called from `main.ts` — so there is nothing to inject
   * from. A module-level instance is right here precisely because tracing state is
   * ambient rather than owned: the whole point is that a log line deep inside a
   * service can find the trace it belongs to without being handed anything.
   */
  private readonly tracing = new TracingService();

  constructor(settings: AppLoggerOptions, context?: string) {
    const base = { logLevels: settings.levels, json: false };

    if (context === undefined) {
      super(base);
    } else {
      super(context, base);
    }

    // Assigned here rather than as a constructor parameter property, because
    // TypeScript emits that assignment before the super call above.
    this.settings = settings;
  }

  override log(message: unknown, ...optional: unknown[]): void {
    this.write('log', message, optional);
  }

  override error(message: unknown, ...optional: unknown[]): void {
    this.write('error', message, optional);
  }

  override warn(message: unknown, ...optional: unknown[]): void {
    this.write('warn', message, optional);
  }

  override debug(message: unknown, ...optional: unknown[]): void {
    this.write('debug', message, optional);
  }

  override verbose(message: unknown, ...optional: unknown[]): void {
    this.write('verbose', message, optional);
  }

  private write(level: LogLevel, message: unknown, optional: unknown[]): void {
    if (!this.settings.levels.includes(level)) {
      return;
    }

    // **Nothing in here may throw.**
    //
    // A logger that can throw breaks the request it was describing, and the three
    // ways it could are all real: `JSON.stringify` rejects a circular reference, a
    // value with a throwing `toJSON` rejects harder, and a stream that is closed
    // rejects the write. An exception escaping a `logger.error` inside a catch
    // block replaces the original error with an unrelated one, which is the worst
    // possible outcome for the one line that was written to explain it.
    //
    // So the entry is rendered defensively and a failure to render degrades to a
    // minimal line rather than propagating. The alternative is an application that
    // cannot report its own faults.
    try {
      this.settings.stream.write(`${this.render(level, message, optional)}\n`);
    } catch {
      try {
        this.settings.stream.write(
          `${JSON.stringify({
            timestamp: new Date().toISOString(),
            level,
            message: 'the log entry could not be rendered',
          })}\n`,
        );
      } catch {
        // The stream itself is gone. There is nowhere left to report this, and
        // throwing here would be the logger taking down the process on its way out.
      }
    }
  }

  /**
   * The JSON line, or a minimal one.
   *
   * `JSON.stringify` is called with a replacer that swallows the failures it can
   * be handed: a circular reference becomes `[circular]` and a value whose
   * `toJSON` throws becomes `[unserialisable]`. Both are objects somebody attached
   * to a log line, so both are their problem rather than a reason to lose the line.
   */
  private render(
    level: LogLevel,
    message: unknown,
    optional: unknown[],
  ): string {
    const entry = this.toEntry({
      level,
      context: this.resolveContext(optional),
      message,
      requestId: getRequestId(),
    });

    const seen = new WeakSet<object>();

    return JSON.stringify(entry, (_key, value: unknown) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[circular]';
        }

        seen.add(value);
      }

      // Only objects can reach here, so this is a value whose `toJSON` has already
      // thrown or recursed — `JSON.stringify` calls it before the replacer sees a
      // primitive.
      if (typeof value === 'function' || typeof value === 'bigint') {
        return String(value);
      }

      return value;
    });
  }

  private resolveContext(optional: unknown[]): string | undefined {
    const positional = optional.find(
      (value): value is string => typeof value === 'string',
    );

    return positional ?? this.context ?? undefined;
  }

  private toEntry(entry: LogEntry): Record<string, unknown> {
    const context = entry.context ? { context: entry.context } : {};
    const requestId = entry.requestId ? { requestId: entry.requestId } : {};
    // Omitted rather than empty. `traceId: ''` on every line of a deployment with
    // no tracing installed is a field a log pipeline has to learn to skip, and one
    // that is always empty is one nobody looks at.
    const traceId = entry.traceId ? { traceId: entry.traceId } : {};

    return {
      timestamp: new Date().toISOString(),
      level: entry.level,
      ...context,
      ...requestId,
      ...traceId,
      // Redacted on the way in, and an `Error` is handled specially rather than
      // passed to `redactForLog` as an object: once flattened, its `message` and
      // `stack` are strings, and the key-based pass does not see inside a string.
      // `logger.error(new Error('reset failed for ?token=abc'))` is exactly the
      // line that leaks, and it is the line written to explain a fault.
      message:
        entry.message instanceof Error
          ? {
              name: entry.message.name,
              message: redactText(entry.message.message),
              stack: redactText(entry.message.stack ?? ''),
            }
          : redactForLog(entry.message),
    };
  }
}

export function createAppLogger(): AppLogger {
  return new AppLogger({
    levels: ['error', 'warn', 'log', 'debug', 'verbose'],
    stream: process.stdout,
  });
}
