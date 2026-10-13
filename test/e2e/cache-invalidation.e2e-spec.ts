import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import {
  API_ROOT,
  applyE2eEnvironment,
  boot,
  cleanState,
  e2eEnabled,
  http,
  registerAndLogin,
  seedAdmin,
} from './harness.js';
import { Permission, Role } from '../../src/common/enums/index.js';
import { UsersService } from '../../src/modules/users/users.service.js';

/**
 * Cache invalidation against a real redis, not a stand-in for one.
 *
 * `auth-cache.spec.ts` proves the same property over a `Map`, which is the right
 * place to prove it because it runs in the unit job on every commit. This one
 * exists for the part a `Map` cannot check: that the delete really reaches redis,
 * that the prefix is the one the reader uses, and that the answer changes on the
 * next request rather than on the next expiry.
 *
 * Every assertion is immediate. Nothing here sleeps, and no test waits out a TTL
 * to prove something expired — a test that waits for an entry to lapse is a test
 * that passes when invalidation is deleted and only costs sixty seconds a day.
 */
describe.skipIf(!e2eEnabled())('cache invalidation (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;
  let userToken: string;

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

    adminToken = await login(app, process.env.ADMIN_EMAIL!);
    userToken = await registerAndLogin(app, 'cache-target@example.test');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves a granted permission on the request after the grant', async () => {
    // Prime the cache first, so the later refusal cannot be explained by the
    // entry having simply never been written.
    await callProtected(userToken).expect(403);

    await replaceGrants([Permission.AdminHealthRead]).expect(200);

    // No TTL wait. The grant has to be visible now, because a grant that takes
    // effect in ten minutes is a grant that is not yet a permission.
    await callProtected(userToken).expect(200);
  });

  it('revokes a permission on the very next request, without waiting a TTL', async () => {
    await callProtected(userToken).expect(200);

    await replaceGrants([]).expect(200);

    const response = await callProtected(userToken).expect(403);

    expect(response.body.message).toContain(Permission.AdminHealthRead);
  });

  it('keeps the admin able to read grants while the user role holds none', async () => {
    const response = await http(app)
      .get(`${API_ROOT}/admin/roles/user/permissions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body.permissions).toEqual([]);
  });

  /**
   * Reads the value straight out of redis, so a passing response cannot be
   * explained by a store that was never written or was bypassed entirely.
   */
  it('evicts the role key from redis rather than relying on its expiry', async () => {
    const { createClient } = await import('redis');
    const client = createClient({ url: process.env.CACHE_URL });
    await client.connect();

    try {
      await replaceGrants([Permission.AdminHealthRead]).expect(200);
      await callProtected(userToken).expect(200);

      const populated = await client.keys(
        `${process.env.CACHE_KEY_PREFIX}:*${Role.User}*`,
      );
      expect(populated.length).toBeGreaterThan(0);

      await replaceGrants([]).expect(200);

      const remaining = await client.keys(
        `${process.env.CACHE_KEY_PREFIX}:*${Role.User}*`,
      );
      expect(remaining).toEqual([]);
    } finally {
      await client.quit();
    }
  });

  it('refuses a soft-deleted caller on the next request', async () => {
    // The other half of the same property: a user row change is a login answer
    // change, and a stale entry here is somebody still authenticated after an
    // erasure request.
    //
    // Deleted through the service, not with `UPDATE`. A write made directly in the
    // database is invisible to invalidation by design — nothing inside the
    // application can see a write it did not make — so a raw statement here would
    // be asserting a limitation as though it were a guarantee.
    const [row] = await dataSource.query<[{ id: string }]>(
      'SELECT id FROM users WHERE email = $1',
      ['cache-target@example.test'],
    );

    await app.get(UsersService).softDelete(row.id, 'e2e');

    await http(app)
      .get(`${API_ROOT}/auth/me`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(401);
  });

  const callProtected = (token: string) =>
    http(app)
      .get(`${API_ROOT}/admin/dashboard`)
      .set('Authorization', `Bearer ${token}`);

  const replaceGrants = (permissions: string[]) =>
    http(app)
      .put(`${API_ROOT}/admin/roles/user/permissions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ permissions });
});

async function login(app: INestApplication, email: string): Promise<string> {
  const response = await http(app)
    .post(`${API_ROOT}/auth/login`)
    .send({ email, password: process.env.ADMIN_PASSWORD })
    .expect(200);

  return response.body.accessToken as string;
}
