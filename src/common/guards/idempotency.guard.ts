import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';

import { IDEMPOTENCY_KEY } from './idempotency.decorator.js';
import type { IdempotencyPolicy } from './idempotency-policy.interface.js';
import {
  IdempotencyInFlightError,
  IdempotencyKeyRequiredError,
} from '../exceptions/idempotency.exceptions.js';
import {
  IDEMPOTENCY_BODY_LIMIT,
  IdempotencyService,
} from '../../modules/queue/idempotency.service.js';

/**
 * Rejects or replays a repeated mutating request.
 *
 * **The problem it solves is narrow and real**: a client sends a `POST`, the
 * response is lost to a timeout, and the client retries. Without this the retry is
 * a second `POST` — a second account, a second invitation, a second charge — and
 * the client has no way to tell the difference between "my first one went through
 * and I lost the answer" and "it never happened".
 *
 * **A header is required, not optional.** A route marked `@Idempotent()` and
 * called without the header is a 400, because a client that does not know about
 * idempotency is exactly the client that will retry blindly. Defaulting it to
 * "generate one for them" would silently promise a guarantee the caller is not
 * making.
 *
 * ## What is replayed
 *
 * The original status and body, verbatim, for routes under
 * `IDEMPOTENCY_BODY_LIMIT`. A retry that created a user gets the same user back
 * rather than a receipt telling it to go and look — which would be the retry this
 * exists to remove, moved one call later.
 *
 * ## What is *not* replayed
 *
 * **Set-cookie headers.** A replayed `Set-Cookie` would re-issue a session to a
 * response the client already has, and cookies are the one part of a response
 * where sending twice is not the same as sending once. The status and body are
 * what a retry needs.
 *
 * ## Fail open
 *
 * If redis cannot be reached the request proceeds. An outage means every mutating
 * request is processed without the protection — degraded, not broken. Failing
 * closed would turn a redis outage into an application that cannot write anything,
 * which trades a partial loss of a convenience guarantee for a total loss of the
 * product.
 */
@Injectable()
export class IdempotencyGuard {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotency: IdempotencyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<
      IdempotencyPolicy | undefined
    >(IDEMPOTENCY_KEY, [context.getHandler(), context.getClass()]);

    // The fast path. A guard bound globally must cost nothing on a route that did
    // not ask for this, or every request in the application pays for a feature most
    // of them do not use.
    if (!policy) {
      return true;
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const clientKey = request.headers['idempotency-key'];

    if (typeof clientKey !== 'string' || clientKey.trim() === '') {
      throw new IdempotencyKeyRequiredError();
    }

    const key = IdempotencyService.buildKey(
      this.scopeFor(request),
      request.method,
      this.pathFor(request),
      clientKey,
    );

    const claim = await this.idempotency.begin(key, policy.inFlightSeconds);

    // Redis said nothing. Proceed, and let the work be done.
    if (claim === null || claim === 'claimed') {
      if (claim === 'claimed') {
        this.rememberCompletion(response, key, policy);
      }

      return true;
    }

    if (claim === 'pending') {
      throw new IdempotencyInFlightError();
    }

    return this.replay(response, claim.status, claim.body);
  }

  /**
   * Records the answer once the handler has produced one.
   *
   * Hooked onto the response rather than awaited afterwards, because the only way
   * to observe a Nest handler's return value from a guard is to let the response
   * event fire — and the response event is exactly the moment the status and body
   * both exist.
   *
   * A non-2xx answer is released rather than recorded. A 400 for a validation
   * failure is worth retrying once the client fixes the body; recording it would
   * replay the rejection for twenty-four hours to a client that had already
   * corrected the thing that was wrong.
   */
  private rememberCompletion(
    response: Response,
    key: string,
    policy: IdempotencyPolicy,
  ): void {
    let settled = false;

    response.on('finish', () => {
      if (settled) {
        return;
      }

      settled = true;

      const status = response.statusCode;

      if (status >= 400) {
        void this.idempotency.release(key);

        return;
      }

      const body = this.bodyOf(response);

      void this.idempotency.complete(
        key,
        {
          status,
          ...(body === undefined ? {} : { body }),
        },
        policy.ttlSeconds,
      );
    });
  }

  /**
   * The response body, when it is small enough to store and is actually there.
   *
   * Read back off the response rather than kept from the handler, because the guard
   * never sees the handler's return value. `undefined` means "do not replay a
   * body", which is the right answer for a 204, for an oversized payload, and for
   * anything that was not captured.
   */
  private bodyOf(response: Response): string | undefined {
    const body = (response as { body?: unknown }).body;

    if (body === undefined || body === null) {
      return undefined;
    }

    let serialised: string;

    try {
      serialised = JSON.stringify(body);
    } catch {
      return undefined;
    }

    return serialised.length > IDEMPOTENCY_BODY_LIMIT ? undefined : serialised;
  }

  /**
   * Sends a stored answer.
   *
   * Returns false, which makes Nest throw a 403 after the response has already
   * been written. That is the wrong-looking route, and it is deliberate: it is the
   * only way a guard can turn a `boolean` into an arbitrary response. The client
   * sees the replayed status and body, which is the whole point; the throw is
   * swallowed by the framework once the response has started.
   */
  private replay(
    response: Response,
    status: number,
    body: string | undefined,
  ): boolean {
    if (body === undefined) {
      response.status(status).end();

      return false;
    }

    response.status(status).type('application/json').send(body);

    return false;
  }

  /**
   * Whose keys these are.
   *
   * The authenticated caller's id where there is one, so two users cannot collide
   * on a shared key they both happened to generate. For a public route the address,
   * which is not an identity — but it is the only thing available, and the same
   * limitation applies to every rate limit keyed on an address.
   */
  private scopeFor(request: Request): string {
    const user = (request as Request & { user?: { id?: string } }).user;

    return user?.id ?? request.ip ?? 'anonymous';
  }

  /**
   * The matched route plus its parameters, not the raw url.
   *
   * `originalUrl` would put a query string in the key, so `?page=2` and `?page=3`
   * would be two different keys for one action and a retry that lost its query
   * would run the work again. The route pattern with the params filled in is the
   * identity of the action.
   */
  private pathFor(request: Request): string {
    const pattern =
      (request.route as { path?: string } | undefined)?.path ??
      (request as Request & { baseUrl?: string }).baseUrl ??
      '';

    const params = request.params
      ? Object.entries(request.params)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => `${key}=${String(value)}`)
          .join('&')
      : '';

    return params === '' ? pattern : `${pattern}?${params}`;
  }
}
