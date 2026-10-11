import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { AuthController } from './auth.controller.js';

/**
 * The gate is opt-in, which means a route added later is open unless somebody
 * remembers the decorator. That is a convention, and a convention nobody can check
 * is a convention that erodes.
 *
 * These read the real metadata off the real handler rather than asserting the
 * controller was edited. A test that re-stated the list would pass with the
 * decorator deleted; this one cannot.
 */

/** The path a handler is mounted at, from the `@Post('…')` or `@Get('…')` value. */
interface RouteUnderTest {
  path: string;
  gated: boolean;
}

function routesOf(controller: object): RouteUnderTest[] {
  const prototype = Object.getPrototypeOf(controller);

  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== 'constructor')
    .flatMap((name) => {
      const handler = prototype[name];

      if (typeof handler !== 'function') {
        return [];
      }

      // Nest writes the path under `path` and the verb under `method` as two
      // separate keys, so a handler is a route when both are present. Reading
      // `path:<verb>` — the guess this started with — finds nothing at all, and
      // every assertion below would have passed vacuously.
      const path = Reflect.getMetadata('path', handler);
      const verb = Reflect.getMetadata('method', handler);

      if (typeof path !== 'string' || typeof verb !== 'number') {
        return [];
      }

      return [
        {
          path: `auth/${path}`,
          gated: Reflect.getMetadata('emailVerified', handler) === true,
        },
      ];
    });
}

const controller = new AuthController({} as never);
const routes = routesOf(controller);

describe('the routes that require a confirmed address', () => {
  /**
   * The narrow set, and the reasoning: these change how an account authenticates or
   * keep a session alive.
   *
   * Deliberately *not* on the list: everything a new account must be able to do
   * before it confirms — read a profile, list sessions, sign out. A gate on those
   * would mean a user who never checks their inbox cannot use their account, which
   * is the failure mode this whole phase is supposed to avoid.
   */
  const gated = [
    'auth/2fa/setup',
    'auth/2fa/verify',
    'auth/2fa/disable',
    'auth/refresh-token',
  ];

  it.each(gated)('gates %s', (path) => {
    expect(routes.find((route) => route.path === path)?.gated).toBe(true);
  });

  const open = [
    'auth/register',
    'auth/login',
    // Completing the second factor is how an unverified user gets in; refusing it
    // would leave them unable to sign in at all.
    'auth/2fa/login',
    'auth/me',
    'auth/devices',
    'auth/devices/:id',
    'auth/sessions',
    'auth/sessions/:id',
    // Signing out must never be gated. A user who suspects a compromise and cannot
    // sign out is worse off than one whose address is unconfirmed.
    'auth/logout',
    'auth/logout-all',
    'auth/forgot-password',
    'auth/reset-password',
    'auth/verify-email',
    'auth/resend-verification',
  ];

  it.each(open)('leaves %s open', (path) => {
    expect(routes.find((route) => route.path === path)?.gated).toBe(false);
  });

  it('lists every route the controller actually has, so a new one cannot slip past both lists', () => {
    // The assertion that makes the lists above meaningful. Without it, a route added
    // next year appears in neither list and every test still passes.
    expect(routes.map((route) => route.path).sort()).toEqual(
      [...gated, ...open].sort(),
    );
  });

  it('does not gate the route that issues the verification link', () => {
    // Gating this would make the only way to fix an unverified account unavailable
    // to an unverified account.
    expect(
      routes.find((route) => route.path === 'auth/verify-email')?.gated,
    ).toBe(false);
  });
});
