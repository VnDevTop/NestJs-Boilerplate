import type { FastifyRequest } from 'fastify';

/**
 * The client's address for an audit row.
 *
 * `request.ip` first, because Nest resolves it against the trust proxy setting and
 * that resolution is the whole point: behind a load balancer, `request.ip` is the
 * balancer unless `trust proxy` is configured, in which case it is the client. The
 * socket address is the fallback for a request object that has no `ip` — a unit
 * test, or an adapter that does not set it.
 *
 * Not the `x-forwarded-for` header directly. That header is client-controlled and
 * unbounded, and reading it without the proxy trust setting behind it would put an
 * attacker's chosen string into every audit row for their address.
 */
export function ipFromRequest(request: FastifyRequest): string | null {
  const ip = request.ip ?? request.socket?.remoteAddress ?? null;

  if (typeof ip !== 'string') {
    return null;
  }

  const trimmed = ip.trim();

  return trimmed === '' ? null : trimmed.slice(0, 100);
}
