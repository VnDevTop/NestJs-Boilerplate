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
  promoteToSuperAdmin,
  registerAndLogin,
  seedAdmin,
} from './harness.js';
import { RetentionService } from '../../src/modules/maintenance/retention.service.js';

/**
 * The dry run, against a real database with real rows in it.
 *
 * The rehearsal is the last thing standing between a mistyped age in
 * `.env.production` and an emptied table, so it is worth proving that it counts
 * exactly what a real run would delete, and deletes none of it. A unit test over
 * mocks can assert the `dryRun` flag reached the query builder; only a database
 * can assert that no row moved.
 *
 * The rows are planted rather than aged. `updatedAt`/`deletedAt` are written
 * directly with a past timestamp, which is the one thing this suite does not do
 * through the application — deliberately, because the age has to be old enough to
 * be past the cutoff and no amount of waiting produces that.
 */
describe.skipIf(!e2eEnabled())('retention dry run (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;
  let staleUserId: string;
  let freshUserId: string;

  beforeAll(async () => {
    applyE2eEnvironment();
    process.env.QUEUE_ENABLED = 'false';
    process.env.RETENTION_ENABLED = 'true';
    // Small enough that one run is quick, and irrelevant to the dry run, which
    // deletes nothing regardless of batching.
    process.env.RETENTION_USERS_DAYS = '30';

    const booted = await boot();
    app = booted.app;
    dataSource = booted.dataSource;

    await cleanState(booted);
    await seedAdmin(dataSource);
    await promoteToSuperAdmin(dataSource, process.env.ADMIN_EMAIL!);

    adminToken = await login(app);
    await registerAndLogin(app, 'stale@example.test');
    await registerAndLogin(app, 'fresh@example.test');

    const rows = await dataSource.query<[{ id: string; email: string }]>(
      'SELECT id, email FROM users WHERE email IN ($1, $2)',
      ['stale@example.test', 'fresh@example.test'],
    );

    staleUserId = rows.find((row) => row.email === 'stale@example.test')!.id;
    freshUserId = rows.find((row) => row.email === 'fresh@example.test')!.id;

    // Soft-deleted and past the thirty-day cutoff, which is the exact shape of a
    // row a real run would remove.
    await dataSource.query(
      `UPDATE users SET "deletedAt" = now() - interval '60 days' WHERE id = $1`,
      [staleUserId],
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  it('counts what a real run would delete', async () => {
    const result = await app.get(RetentionService).run({ dryRun: true });

    expect(result.dryRun).toBe(true);

    const users = result.targets.find((target) => target.id === 'users');

    // Exactly one. A rehearsal that under-reports is worse than a slow one,
    // because it is the report an operator trusts.
    expect(users?.deleted).toBe(1);
  });

  it('deletes nothing at all', async () => {
    const before = await countUsers(dataSource);
    await app.get(RetentionService).run({ dryRun: true });
    const after = await countUsers(dataSource);

    expect(after).toBe(before);
  });

  it('leaves both rows individually, including the one it counted', async () => {
    const rows = await dataSource.query<{ id: string }[]>(
      'SELECT id FROM users WHERE id = ANY($1)',
      [[staleUserId, freshUserId]],
    );

    expect(rows.map((row) => row.id).sort()).toEqual(
      [staleUserId, freshUserId].sort(),
    );
  });

  it('keeps a row that is soft-deleted but inside the window', async () => {
    // The other direction, and the one a misconfigured age is most likely to get
    // wrong: yesterday's deletion is not thirty days old.
    await dataSource.query(
      `UPDATE users SET "deletedAt" = now() - interval '1 day' WHERE id = $1`,
      [freshUserId],
    );

    const result = await app.get(RetentionService).run({ dryRun: true });
    const users = result.targets.find((target) => target.id === 'users');

    expect(users?.deleted).toBe(1);
    expect(await countUsers(dataSource)).toBeGreaterThanOrEqual(3);
  });

  it('reports the dry run over the admin api, and records it', async () => {
    const response = await http(app)
      .post(`${API_ROOT}/admin/retention/dry-run`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body).toMatchObject({ dryRun: true, totalDeleted: 1 });

    // The dry run is an operational event, and a rehearsal that left no trace
    // could not be told apart from one that never happened.
    const [row] = await dataSource.query<[{ count: string }]>(
      `SELECT count(*)::text AS count FROM maintenance_logs WHERE "dryRun" = true`,
    );

    expect(Number(row.count)).toBeGreaterThan(0);
  });
});

async function countUsers(dataSource: DataSource): Promise<number> {
  const [row] = await dataSource.query<[{ count: string }]>(
    'SELECT count(*)::text AS count FROM users',
  );
  return Number(row.count);
}

async function login(app: INestApplication): Promise<string> {
  const response = await http(app)
    .post(`${API_ROOT}/auth/login`)
    .send({
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    })
    .expect(200);

  return response.body.accessToken as string;
}
