import 'reflect-metadata';

import { RequestMethod } from '@nestjs/common';

import { describe, expect, it } from 'vitest';

import { AdminMailTemplatesController } from '../admin/mail-templates.controller.js';
import { AdminRolesController } from '../admin/roles.controller.js';
import { UsersController } from '../users/users.controller.js';

/**
 * Every privileged route carries `@Audited()`.
 *
 * The decorator is opt-in, which means a route added without it is unaudited and
 * nothing else in the system says so. That is the same trade the verified-email
 * gate makes, and the same answer: a convention nobody can check is a convention
 * that erodes — so this reads the real handler metadata and fails when a
 * privileged route has drifted out of coverage.
 *
 * **Why opt-in at all, given this file exists to enforce coverage.** The
 * opposite — a global interceptor that audits every request — produces a table
 * dominated by profile reads and sign-ins, and the entries that matter are the
 * ones nobody scrolls to. A short explicit list is also a list somebody actually
 * read, which is what makes "is this route privileged?" answerable rather than
 * guessed at.
 *
 * These assertions read the decorators off the real handlers rather than
 * re-stating them. A test that restated the list would pass with every `@Audited`
 * deleted, which is exactly the failure this file exists to catch.
 */

interface RouteUnderTest {
  /** `prefix/METHOD path`, e.g. `users/PATCH :id`. */
  path: string;
  action: string | undefined;
}

/**
 * Walks a controller's prototype for route handlers.
 *
 * Nest writes the path under `path` and the verb under `method` as two separate
 * keys, so a method is a route when both are present. Reading `path:<verb>` finds
 * nothing at all, and every assertion below would pass vacuously.
 */
function routesOf(controller: object, prefix: string): RouteUnderTest[] {
  const prototype = Object.getPrototypeOf(controller);

  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== 'constructor')
    .flatMap((name) => {
      const handler = prototype[name];

      if (typeof handler !== 'function') {
        return [];
      }

      const path = Reflect.getMetadata('path', handler);
      const verb = Reflect.getMetadata('method', handler);

      if (typeof path !== 'string' || typeof verb !== 'number') {
        return [];
      }

      const policy = Reflect.getMetadata('audit', handler) as
        { action: string } | undefined;

      return [
        {
          // A bare `@Post()` records its path as `/`, and printing that literally
          // would make `users/POST /` a different string from `users/POST` — which
          // would fail the existence check below for a route still right there.
          //
          // The verb comes from `RequestMethod` rather than an array spelled out
          // here: its numeric order is GET, POST, PUT, DELETE, PATCH, and guessing
          // that order wrong turns `PATCH :id` into a `PUT` and makes the coverage
          // check silently blind to exactly the routes it exists to cover.
          path: `${prefix}/${RequestMethod[verb]}${
            path === '/' ? '' : ` ${path}`
          }`,
          action: policy?.action,
        },
      ];
    });
}

const usersRoutes = routesOf(
  new UsersController({} as never, {} as never),
  'users',
);
const roleRoutes = routesOf(
  new AdminRolesController({} as never),
  'admin/roles',
);
const templateRoutes = routesOf(
  new AdminMailTemplatesController({} as never),
  'admin/mail-templates',
);
// Listed explicitly rather than discovered from `AppModule`, because this file must
// run without a database, a redis or a module graph — the same constraint that made
// `app.module.spec.ts` build the graph with a stubbed data source rather than the
// real one. A controller added here without a matching entry fails the existence
// check below, which is the intended direction of that asymmetry.
const routes = [...usersRoutes, ...roleRoutes, ...templateRoutes];

/**
 * The privileged routes, and the action name each must carry.
 *
 * `action` rather than a bare presence flag: an entry with an empty action would
 * pass a presence check and leave an unqueryable string in the column an operator
 * filters on. The whole point of a column is that the value can be queried.
 */
const PRIVILEGED: Record<string, string> = {
  'users/POST': 'users.create',
  'users/PATCH :id': 'users.update',
  'users/DELETE :id': 'users.delete',
  'admin/roles/PUT :role/permissions': 'roles.permissions.replace',
  // Phase 22. A template is the wording of a security message, so who changed it is
  // the question an incident starts from.
  'admin/mail-templates/PUT :name': 'templates.mail.update',
  'admin/mail-templates/DELETE :name': 'templates.mail.reset',
};

describe('privileged routes', () => {
  it('all still exist, so a renamed route fails here rather than going quiet', () => {
    // The failure this file exists for. A route moved from `users/PATCH :id` would
    // leave the expected key matching nothing, and every other assertion would
    // still pass over a list that no longer describes the application.
    for (const expected of Object.keys(PRIVILEGED)) {
      expect(
        routes.map((route) => route.path),
        `${expected} is no longer a route`,
      ).toContain(expected);
    }
  });

  it('are all audited, under the right action name', () => {
    for (const [path, action] of Object.entries(PRIVILEGED)) {
      expect(routes.find((route) => route.path === path)?.action, path).toBe(
        action,
      );
    }
  });

  it('leaves the read routes unaudited, because reading is not privileged', () => {
    // `GET /users` lists every account with every field on it. Recording a row per
    // request is how an audit table stops being readable: the privileged writes
    // would be a handful of entries among thousands of profile reads.
    expect(
      routes.find((route) => route.path === 'users/GET')?.action,
    ).toBeUndefined();
    expect(
      routes.find((route) => route.path === 'users/GET :id')?.action,
    ).toBeUndefined();
  });

  it('leaves the read side of the permissions route unaudited too', () => {
    // Reading what a role holds changes nothing. The write is the one that matters.
    expect(
      routes.find((route) => route.path === 'admin/roles/GET :role/permissions')
        ?.action,
    ).toBeUndefined();
  });

  it('names every audited action in the dotted form the column is queried by', () => {
    // `entity.action`, matching the notification event names. A reader asking
    // "show me every users.update" needs the string to be exact, and an ad-hoc
    // spelling is a string nobody can query.
    for (const route of routes) {
      if (route.action === undefined) {
        continue;
      }

      expect(route.action, route.path).toMatch(
        /^[a-z][a-zA-Z]*\.[a-z][a-zA-Z.]+$/,
      );
    }
  });

  it('gives every audited route a unique action name per route, not per controller', () => {
    // Two routes sharing an action would be indistinguishable in the table, and
    // "which one" is the first question an operator asks.
    const audited = routes.filter((route) => route.action !== undefined);
    const actions = audited.map((route) => route.action);

    expect(new Set(actions).size).toBe(actions.length);
  });
});
