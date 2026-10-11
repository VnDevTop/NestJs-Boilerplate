import { ExecutionContext, ForbiddenException } from '@nestjs/common';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RequireVerifiedEmailGuard } from './require-verified-email.guard.js';
import type { RequestUser } from '../interfaces/index.js';

/**
 * The polarity is the whole design. A gate that defaults on would lock a new user
 * out of the routes they need to verify their address, and would make `register` —
 * which returns a token for an unverified account — pointless. So the absence of
 * the decorator has to mean "open", and that is asserted first.
 */

function reflectorFor(required?: boolean) {
  return {
    getAllAndOverride: vi.fn(() => required),
  } as never;
}

const verified: RequestUser = {
  id: 'u1',
  email: 'a@x.com',
  role: 'user',
  isManager: false,
  isActive: true,
  permissions: [],
  isEmailVerified: true,
};

const unverified: RequestUser = { ...verified, isEmailVerified: false };

function contextFor(user?: RequestUser): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

let guard: RequireVerifiedEmailGuard;

beforeEach(() => {
  guard = new RequireVerifiedEmailGuard(reflectorFor(true));
});

describe('a route that did not ask for the gate', () => {
  it('is open, because the gate is opt-in', () => {
    const open = new RequireVerifiedEmailGuard(reflectorFor(undefined));

    expect(open.canActivate(contextFor(unverified))).toBe(true);
  });

  it('is open even when the decorator explicitly said false', () => {
    // The decorator only ever sets true, so this is unreachable in practice — but a
    // falsy value and an absent one must not be told apart by accident.
    const open = new RequireVerifiedEmailGuard(reflectorFor(false));

    expect(open.canActivate(contextFor(unverified))).toBe(true);
  });

  it("does not read the user at all, so an unauthenticated call is not this gate's problem", () => {
    // The JWT guard runs first. A guard that threw here would turn a public route
    // into a 403 for no reason.
    const open = new RequireVerifiedEmailGuard(reflectorFor(undefined));

    expect(open.canActivate(contextFor(undefined))).toBe(true);
  });
});

describe('a route that asked for the gate', () => {
  it('admits a verified caller', () => {
    expect(guard.canActivate(contextFor(verified))).toBe(true);
  });

  it('refuses an unverified caller', () => {
    expect(() => guard.canActivate(contextFor(unverified))).toThrow(
      ForbiddenException,
    );
  });

  it('refuses a caller with no user, which means the decorator was misapplied', () => {
    // Loud rather than silent: a public route carrying this gate is a programming
    // error, and passing it through would be a route nobody thought about.
    expect(() => guard.canActivate(contextFor(undefined))).toThrow(
      ForbiddenException,
    );
  });

  it('says how to fix it, because a bare 403 on an authenticated route reads as a bug', () => {
    // A user who cannot tell why they are refused files a support ticket instead of
    // clicking the link that fixes it.
    expect(() => guard.canActivate(contextFor(unverified))).toThrow(
      /resend-verification/,
    );
  });

  it('answers 403 rather than 401, so a client does not try to refresh its token', () => {
    // The caller *is* authenticated. A 401 tells a well-written client to refresh,
    // which succeeds and changes nothing, and the retry loop is how a gate like this
    // ends up looking like a session bug.
    expect(() => guard.canActivate(contextFor(unverified))).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  it('reads the flag the strategy resolved rather than looking the user up', () => {
    // The reason the flag is on the cached projection. A guard that queried would
    // put a database round trip on every request to every gated route.
    const getRequest = vi.fn(() => ({ user: verified }));

    guard.canActivate({
      switchToHttp: () => ({ getRequest }),
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
    } as unknown as ExecutionContext);

    expect(getRequest).toHaveBeenCalledTimes(1);
  });
});

describe('the metadata key', () => {
  it('is read from both the handler and the class', () => {
    // A controller-level gate is the natural way to protect a whole controller, and
    // a lookup that ignored the class would silently not apply it.
    const reflector = { getAllAndOverride: vi.fn() };

    new RequireVerifiedEmailGuard(reflector as never).canActivate(
      contextFor(verified),
    );

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith('emailVerified', [
      expect.any(Function),
      expect.any(Function),
    ]);
  });
});
