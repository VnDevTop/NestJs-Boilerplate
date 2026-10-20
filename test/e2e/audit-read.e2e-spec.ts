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
  waitFor,
} from './harness.js';

/**
 * The trail, read over the wire.
 *
 * **The acceptance criterion, stated as a test.** Phase 26 is done when an
 * incident can be investigated without leaving the application and writing SQL.
 * So: an administrator does something privileged, and then asks the application
 * what happened — and the answer is there, filtered to the question that was
 * asked.
 *
 * The unit suite covers the query layer and the permission decision. What it
 * cannot cover is that the route is reachable, that the guards are the ones the
 * decorators claim, and that the row the interceptor writes is the row the route
 * reads — which is a question about two halves of the application meeting.
 */
describe.skipIf(!e2eEnabled())('reading the audit trail (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;
  let createdUserId: string;

  beforeAll(async () => {
    applyE2eEnvironment();
    process.env.QUEUE_ENABLED = 'false';

    const booted = await boot();
    app = booted.app;
    dataSource = booted.dataSource;

    await cleanState(booted);
    await seedAdmin();
    await promoteToSuperAdmin();

    adminToken = await login();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('shows the administrator what they just did', async () => {
    // The audited action. `POST /users` is one of the six routes the audit
    // policy names, and the id of what it created is the target.
    const created = await http(app)
      .post(`${API_ROOT}/users`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: 'audited@example.test',
        password: 'E2e-password-1-Strong',
        firstName: 'Audited',
        lastName: 'User',
      })
      .expect(201);

    createdUserId = created.body.data.id as string;

    // The write is not awaited by the request that caused it, so the row lands
    // shortly afterwards. Polled rather than slept on, so the test is neither
    // slow nor flaky.
    await waitFor(async () => (await countEntries('users.create')) > 0, {
      description: 'the audit row to be written',
    });

    const response = await http(app)
      .get(
        `${API_ROOT}/admin/audit?action=users.create&targetId=${createdUserId}`,
      )
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const entries = response.body.data as Array<Record<string, unknown>>;

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'users.create',
      targetType: 'user',
      targetId: createdUserId,
      actorType: 'user',
      outcome: 'success',
    });
  });

  it('answers the question rather than the whole trail', async () => {
    const response = await http(app)
      .get(`${API_ROOT}/admin/audit?action=users.create`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const entries = response.body.data as Array<Record<string, unknown>>;

    // Only that action. A filter that did not narrow would look identical on a
    // trail with one entry in it, which is why the target filter above is the
    // one that proves it.
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.action === 'users.create')).toBe(
      true,
    );
  });

  it('finds nothing for an action that did not happen', async () => {
    const response = await http(app)
      .get(`${API_ROOT}/admin/audit?action=users.delete`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body.data).toEqual([]);
  });

  it('reads a window, and refuses one without a timezone', async () => {
    const now = new Date();
    const from = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

    const response = await http(app)
      .get(`${API_ROOT}/admin/audit?from=${from}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect((response.body.data as unknown[]).length).toBeGreaterThan(0);

    // A timestamp without an offset means different instants on two deployments,
    // so it is refused rather than interpreted.
    await http(app)
      .get(`${API_ROOT}/admin/audit?from=2026-10-20T09:00:00`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('refuses an ordinary user', async () => {
    const token = await registerAndLogin(app, 'nosy@example.test');

    await http(app)
      .get(`${API_ROOT}/admin/audit`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('refuses an administrator, which is the recorded decision', async () => {
    // The trail is the record of what every privileged actor did. An
    // administrator is one of them, and the permission is held by the super
    // administrator alone.
    await http(app)
      .post(`${API_ROOT}/users`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: 'plain-admin@example.test',
        password: 'E2e-password-1-Strong',
        firstName: 'Plain',
        lastName: 'Admin',
        role: 'admin',
        isManager: true,
      })
      .expect(201);

    const token = await loginAs(
      'plain-admin@example.test',
      'E2e-password-1-Strong',
    );

    await http(app)
      .get(`${API_ROOT}/admin/audit`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('does not write to the trail when it is read', async () => {
    const before = await countEntries('users.create');

    await http(app)
      .get(`${API_ROOT}/admin/audit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // A read that wrote to the trail would make it grow every time somebody
    // looked at it, and every investigation would add an entry about itself.
    expect(await countEntries('users.create')).toBe(before);
  });

  async function countEntries(action: string): Promise<number> {
    const [row] = await dataSource.query<[{ count: string }]>(
      'SELECT count(*)::text AS count FROM audit_logs WHERE action = $1',
      [action],
    );

    return Number(row.count);
  }

  async function seedAdmin(): Promise<void> {
    const { PermissionSeeder } =
      await import('../../src/database/seeds/permission.seeder.js');
    const { AdminSeeder } =
      await import('../../src/database/seeds/admin.seeder.js');

    await new PermissionSeeder().run(dataSource);
    await new AdminSeeder().run(dataSource);
  }

  async function promoteToSuperAdmin(): Promise<void> {
    const { Role } = await import('../../src/common/enums/index.js');

    await dataSource.query('UPDATE users SET role = $1 WHERE email = $2', [
      Role.SuperAdmin,
      process.env.ADMIN_EMAIL!,
    ]);
  }

  async function login(): Promise<string> {
    return loginAs(process.env.ADMIN_EMAIL!, process.env.ADMIN_PASSWORD!);
  }

  async function loginAs(email: string, password: string): Promise<string> {
    const response = await http(app)
      .post(`${API_ROOT}/auth/login`)
      .send({ email, password })
      .expect(200);

    return response.body.data.accessToken as string;
  }
});
