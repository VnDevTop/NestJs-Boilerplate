import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { RedisClientType } from 'redis';

import {
  API_ROOT,
  applyE2eEnvironment,
  boot,
  cleanState,
  e2eEnabled,
  http,
  promoteToSuperAdmin,
  registerAndLogin,
  seedAdmin,
} from './harness.js';
import { Permission, Role } from '../../src/common/enums/index.js';
import { authRoleKey, authUserKey } from '../../src/core/cache/index.js';
import { PermissionsService } from '../../src/modules/users/permissions.service.js';
import { UsersService } from '../../src/modules/users/users.service.js';

/**
 * Cache invalidation against a real redis, not a stand-in for one.
 *
 * `auth-cache.spec.ts` proves the same property over a `Map`, which is the right
 * place to prove it because it runs in the unit job on every commit. This one
 * exists for the part a `Map` cannot check: that the delete really reaches
 * redis, under the prefix the reader uses, and that the answer changes on the
 * next request rather than on the next expiry.
 *
 * Two caches are covered, because they are invalidated in different places:
 *
 * - `user:<id>`, the claims, dropped by every write that moves an
 *   authentication answer. Exercised over http, because that is the only way to
 *   show the *next request* is refused.
 * - `role:<role>`, the grants, dropped by the write that replaces them.
 *   Exercised through the service, because every route carrying
 *   `@Permissions()` also carries `@Roles(Admin, SuperAdmin)`: a plain user is
 *   refused by the role guard first, so an http test here would pass with the
 *   permission cache deleted.
 *
 * No assertion waits out a TTL. A cache test that sleeps for an entry to expire
 * passes just as well when the invalidation is removed, and only costs a minute a
 * day.
 */
describe.skipIf(!e2eEnabled())('cache invalidation (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let redis: RedisClientType;
  let adminToken: string;
  let userToken: string;
  let userId: string;

  beforeAll(async () => {
    applyE2eEnvironment();
    // The in-house fallback, not bullmq: this is about cache keys, and a second
    // moving part would only add a way for the suite to fail for the wrong reason.
    process.env.QUEUE_ENABLED = 'false';

    const booted = await boot();
    app = booted.app;
    dataSource = booted.dataSource;

    await cleanState(booted);
    await seedAdmin(dataSource);
    await promoteToSuperAdmin(dataSource, process.env.ADMIN_EMAIL!);

    const { createClient } = await import('redis');
    redis = createClient({ url: process.env.CACHE_URL }) as RedisClientType;
    await redis.connect();

    adminToken = await login(
      app,
      process.env.ADMIN_EMAIL!,
      process.env.ADMIN_PASSWORD!,
    );
    userToken = await registerAndLogin(app, 'cache-target@example.test');

    [userId] = await idOf('cache-target@example.test');
  });

  afterAll(async () => {
    await redis?.quit();
    await app?.close();
  });

  it('caches the claims a request is authorised from', async () => {
    // Prime it, so a later refusal cannot be explained by an entry that was
    // never written.
    await http(app)
      .get(`${API_ROOT}/auth/me`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);

    expect(await redis.exists(cacheKey(authUserKey(userId)))).toBe(1);
  });

  it('refuses a locked account on the next request', async () => {
    await app.get(UsersService).lockAccount(userId, 'e2e test');

    const response = await http(app)
      .get(`${API_ROOT}/auth/me`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(401);

    // The same message an unregistered address gets. A dedicated one would be a
    // free oracle to anybody willing to burn twenty attempts.
    expect(response.body.message).toMatch(/invalid|unauthor/i);
  });

  it('lets the account back in when it is unlocked', async () => {
    await app.get(UsersService).unlockAccount(userId, 'e2e test');

    await http(app)
      .get(`${API_ROOT}/auth/me`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
  });

  it('refuses a soft-deleted caller on the next request', async () => {
    // Deleted through the service, not with `UPDATE`. A write made directly in
    // the database is invisible to invalidation by design — nothing inside the
    // application can see a write it did not make — so a raw statement here would
    // be asserting a limitation as though it were a guarantee.
    await app.get(UsersService).softDelete(userId, 'e2e');

    await http(app)
      .get(`${API_ROOT}/auth/me`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(401);
  });

  it('evicts the role key from redis rather than relying on its expiry', async () => {
    const permissions = app.get(PermissionsService);
    const key = cacheKey(authRoleKey(Role.User));

    await permissions.setForRole(Role.User, [Permission.UserRead]);
    await permissions.forRole(Role.User);
    expect(await redis.exists(key)).toBe(1);

    await permissions.setForRole(Role.User, [
      Permission.UserRead,
      Permission.UserWrite,
    ]);

    // Asserted between the write and the next read, because a read that repopulated
    // it first would hide the miss and make a deleted invalidation look alive.
    expect(await redis.exists(key)).toBe(0);

    // And the next read carries the new set, so the entry that comes back is not
    // the one that was just evicted.
    await expect(permissions.forRole(Role.User)).resolves.toEqual(
      expect.arrayContaining([Permission.UserRead, Permission.UserWrite]),
    );
  });

  it('serves a replaced grant immediately, over http', async () => {
    // The admin route exists so that changing a grant goes through the
    // application, and therefore through the invalidation. Using it here rather
    // than the service is what makes this the test an operator would recognise.
    const [id] = await idOf('cache-target@example.test');

    await http(app)
      .get(`${API_ROOT}/admin/roles/user/permissions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await http(app)
      .put(`${API_ROOT}/admin/roles/user/permissions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ permissions: [Permission.UserRead] })
      .expect(200);

    // Reads it back through the application rather than redis, so a passing
    // assertion cannot be explained by a key that was never written.
    const response = await http(app)
      .get(`${API_ROOT}/admin/roles/user/permissions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body.data.permissions).toEqual([Permission.UserRead]);
    expect(id).toBeTruthy();
  });

  /** Cache keys go through keyv, which applies the configured prefix itself. */
  const cacheKey = (key: string): string =>
    `${process.env.CACHE_KEY_PREFIX}:${key}`;

  async function idOf(email: string): Promise<[string]> {
    const [row] = await dataSource.query<[{ id: string }]>(
      'SELECT id FROM users WHERE email = $1',
      [email],
    );
    return [row.id];
  }
});

async function login(
  app: INestApplication,
  email: string,
  password: string | undefined,
): Promise<string> {
  const response = await http(app)
    .post(`${API_ROOT}/auth/login`)
    .send({ email, password })
    .expect(200);

  return response.body.data.accessToken as string;
}
