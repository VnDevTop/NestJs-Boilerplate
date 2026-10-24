import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { Observable, catchError, tap, throwError } from 'rxjs';

import { AUDIT_KEY, type AuditPolicy } from '../../common/constants/index.js';
import { getRequestId } from '../../common/utils/index.js';
import {
  AuditService,
  type AuditActor,
  type AuditEntry,
} from './audit.service.js';
import { ipFromRequest } from './ip.util.js';

/** The request, with the two properties the guards attach and the routes read. */
type AuditedRequest = FastifyRequest & {
  user?: { id?: string; email?: string };
};

/**
 * Writes an audit entry for every route that asked for one.
 *
 * **Not global, and not registered as `APP_INTERCEPTOR`.** A global interceptor
 * would run on every request and have to check metadata to decide there was nothing
 * to do — which is the shape that ends up logging every profile read. This one is
 * bound per controller with `@UseInterceptors(AuditInterceptor)` and decides per
 * route from the `@Audited()` decorator.
 *
 * That failure mode is different from a guard's, and the mitigation is the same:
 * `audit-policy.spec.ts` reads the real handler metadata and asserts the privileged
 * routes carry the decorator, because a convention nobody can check is a convention
 * that erodes.
 *
 * ## Failures are recorded too
 *
 * `catchError` writes an entry for a refused request and rethrows the original
 * error. The catch is not for the caller — it rethrows unchanged — it is so a
 * refused permission leaves a row. A permission that was refused is evidence; a
 * permission that was never asked for is not.
 *
 * ## `before` is null, always
 *
 * The interceptor sees the request and the response, never the row as it was. A
 * reconstructed "before" in a table presented as evidence is worse than none: it
 * looks like a record and is an inference. Routes whose before-state is worth
 * having are the ones where the service read the row and knows, and those call
 * `AuditService.record` directly with both sides.
 *
 * ## Fire and forget
 *
 * The write is never awaited. It goes to the database the request already used, and
 * `AuditService.record` never throws, so there is nothing to wait for and something
 * to lose: the response time of every privileged action.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const policy = this.reflector.getAllAndOverride<AuditPolicy | undefined>(
      AUDIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    // The fast path, and the reason this is safe to bind broadly: a route without
    // `@Audited()` returns without touching the request, the database or a promise.
    if (!policy) {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<AuditedRequest>();
    const writes = (entry: AuditEntry): void => {
      void this.audit.record(entry, this.contextOf(request));
    };

    return next.handle().pipe(
      tap((result) => {
        writes(this.entryFor(policy, request, 'success', result));
      }),
      catchError((error: unknown) => {
        if (policy.recordFailures ?? true) {
          writes(this.entryFor(policy, request, 'failure', null, error));
        }

        return throwError(() => error);
      }),
    );
  }

  private entryFor(
    policy: AuditPolicy,
    request: AuditedRequest,
    outcome: 'success' | 'failure',
    result: unknown,
    error?: unknown,
  ): AuditEntry {
    return {
      actor: this.actorFor(request.user),
      action: policy.action,
      targetType: policy.targetType,
      targetId: this.targetId(policy, request, result),
      before: null,
      after:
        outcome === 'success' && policy.diffResponse !== false
          ? this.snapshot(result)
          : null,
      outcome,
      statusCode: this.statusOf(error),
      error: error instanceof Error ? error.message : undefined,
    };
  }

  /**
   * `user` for an authenticated caller, `anonymous` for everything else.
   *
   * Two values, not three: a system action never arrives through a request. Those
   * are written by the service that performed them, not by this.
   */
  private actorFor(user: AuditedRequest['user']): AuditActor {
    if (!user?.id) {
      return { id: null, email: null, type: 'anonymous' };
    }

    return { id: user.id, email: user.email ?? null, type: 'user' };
  }

  /**
   * Where the acted-upon id comes from, tried in the order the route declared.
   *
   * A list because the three shapes are genuinely different routes: a delete takes
   * its id from the path, a self-service route has no id in the path at all, and a
   * create only learns the id from what it made. Falling through to null rather than
   * throwing is deliberate — an audit entry with a null target is still evidence
   * that the action ran, and failing a request because its audit metadata was
   * incomplete would be a self-inflicted outage.
   */
  private targetId(
    policy: AuditPolicy,
    request: AuditedRequest,
    result: unknown,
  ): string | null {
    for (const source of policy.targetIdFrom ?? []) {
      const found =
        typeof source === 'string'
          ? this.fromShorthand(source, request, result)
          : this.fromParam(source[1], request);

      if (found !== null) {
        return found;
      }
    }

    return null;
  }

  private fromShorthand(
    source: 'user' | 'result',
    request: AuditedRequest,
    result: unknown,
  ): string | null {
    return source === 'user' ? (request.user?.id ?? null) : this.idOf(result);
  }

  private fromParam(name: string, request: AuditedRequest): string | null {
    const value = (request.params as Record<string, unknown> | undefined)?.[
      name
    ];

    return typeof value === 'string' && value !== '' ? value : null;
  }

  /** The `id` off a response, whatever shape it arrived in. */
  private idOf(result: unknown): string | null {
    if (result !== null && typeof result === 'object' && 'id' in result) {
      const id = (result as { id: unknown }).id;

      return typeof id === 'string' ? id : null;
    }

    return null;
  }

  /**
   * The response, as a plain object.
   *
   * Arrays and primitives contribute nothing: a list of sessions or an empty 204
   * has no single subject to name, and `diffResponse` is turned off for those routes
   * anyway. Spread rather than a JSON round trip so a class instance contributes
   * its own fields rather than whatever a serializer would do to it — which is how
   * a serializer written for one response ends up in an audit row for another.
   */
  private snapshot(result: unknown): Record<string, unknown> | null {
    if (
      result === null ||
      typeof result !== 'object' ||
      Array.isArray(result)
    ) {
      return null;
    }

    return { ...(result as Record<string, unknown>) };
  }

  /**
   * The status the error carries.
   *
   * Read through `getStatus` rather than by matching on class. Anything without one
   * is stored as null rather than guessed at 500: an error that never reached the
   * client has no status, and writing a wrong one into an audit table is a small
   * lie that is expensive to notice later.
   */
  private statusOf(error?: unknown): number | null {
    if (error === undefined) {
      return null;
    }

    const status = (error as { getStatus?: () => number }).getStatus;

    return typeof status === 'function' ? status.call(error) : null;
  }

  /**
   * The request-scoped half of every entry.
   *
   * `getRequestId()` first, from the AsyncLocalStorage the request-id middleware
   * populates — that is the same id the log lines carry, which is what makes an
   * entry an investigation rather than a record. The header is the fallback for a
   * context that never ran the middleware.
   */
  /** The first value of a header that may arrive repeated, or null. */
  private firstHeader(value: string | string[] | undefined): string | null {
    const single = Array.isArray(value) ? value[0] : value;

    return typeof single === 'string' && single !== '' ? single : null;
  }

  private contextOf(request: AuditedRequest): {
    ipAddress: string | null;
    userAgent: string | null;
    requestId: string | null;
  } {
    return {
      ipAddress: ipFromRequest(request),
      // Headers are `string | string[]`, and a repeated `user-agent` header arrives
      // as an array. The first is the one a client actually sent first, which is the
      // one worth recording; joining the array would put a caller's chosen
      // separator into an audit row.
      userAgent: this.firstHeader(request.headers?.['user-agent']),
      requestId:
        getRequestId() ?? this.firstHeader(request.headers?.['x-request-id']),
    };
  }
}
