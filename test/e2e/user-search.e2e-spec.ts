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

/**
 * The search, against a real database with real rows in it.
 *
 * **The unit suite can prove the SQL is shaped right; only a database can prove
 * that the rows it matches are the rows it should.** A `tsvector` is computed by
 * postgres from the row's own text, the `ts_rank` is postgres's, and the GIN
 * index is postgres's — none of which exist in a mock. So the rows are planted
 * and the answers are checked against the rows.
 */
describe.skipIf(!e2eEnabled())('user search (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    applyE2eEnvironment();
    process.env.QUEUE_ENABLED = 'false';

    const booted = await boot();
    app = booted.app;
    dataSource = booted.dataSource;

    await cleanState(booted);
    await seedAdmin(dataSource);
    await promoteToSuperAdmin(dataSource, process.env.ADMIN_EMAIL!);

    adminToken = await login();

    // Two people, one of whom matches and one of whom does not. The names are
    // distinct on purpose: a search that returned everybody would pass against
    // a single row.
    await createUser('ada@example.test', 'Ada', 'Lovelace');
    await createUser('grace@example.test', 'Grace', 'Hopper');

    userToken = await registerAndLogin(app, 'nosy@example.test');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('finds the user whose name matches', async () => {
    const response = await http(app)
      .post(`${API_ROOT}/users/search`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ query: 'ada' })
      .expect(200);

    const items = response.body.data.items as Array<{
      email: string;
      score: number;
    }>;

    expect(items).toHaveLength(1);
    expect(items[0]?.email).toBe('ada@example.test');
    // The score is the rank, and a match has one.
    expect(items[0]?.score).toBeGreaterThan(0);
  });

  it('does not find the user whose name does not', async () => {
    const response = await http(app)
      .post(`${API_ROOT}/users/search`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ query: 'ada' })
      .expect(200);

    const items = response.body.data.items as Array<{ email: string }>;

    expect(items.map((item) => item.email)).not.toContain('grace@example.test');
  });

  it('finds by a field, and by a phrase', async () => {
    const byField = await http(app)
      .post(`${API_ROOT}/users/search`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ query: 'lastName:Lovelace' })
      .expect(200);

    expect(
      (byField.body.data.items as Array<{ email: string }>).map(
        (item) => item.email,
      ),
    ).toEqual(['ada@example.test']);

    const byPhrase = await http(app)
      .post(`${API_ROOT}/users/search`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ query: '"ada lovelace"' })
      .expect(200);

    expect(
      (byPhrase.body.data.items as Array<{ email: string }>).map(
        (item) => item.email,
      ),
    ).toEqual(['ada@example.test']);
  });

  it('finds by a field that is not text, exactly', async () => {
    const response = await http(app)
      .post(`${API_ROOT}/users/search`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ query: 'role:user' })
      .expect(200);

    // A keyword is compared for equality, not matched as a substring, so this
    // finds the accounts and not the word.
    const items = response.body.data.items as Array<{ email: string }>;

    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.email.endsWith('@example.test'))).toBe(
      true,
    );
  });

  it('counts the matching rows per facet', async () => {
    const response = await http(app)
      .post(`${API_ROOT}/users/search`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ query: 'ada', facets: ['role'] })
      .expect(200);

    const facets = response.body.data.facets as Record<
      string,
      Array<{ value: string; count: number }>
    >;

    // The counts come from the same filter as the results, so the one row that
    // matched is the one row that is counted.
    expect(facets['role']).toEqual([{ value: 'user', count: 1 }]);
  });

  it('refuses an unknown field, and says which fields exist', async () => {
    const response = await http(app)
      .post(`${API_ROOT}/users/search`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ query: 'emial:ada' })
      .expect(400);

    expect(JSON.stringify(response.body)).toContain('email');
  });

  it('refuses a query it cannot parse', async () => {
    await http(app)
      .post(`${API_ROOT}/users/search`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ query: 'ada AND' })
      .expect(400);
  });

  it('refuses an ordinary user', async () => {
    // The search reads user records and finds them by name, so it is behind the
    // permission that says a caller may read a user record.
    await http(app)
      .post(`${API_ROOT}/users/search`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ query: 'ada' })
      .expect(403);
  });

  it('refuses a caller with no token at all', async () => {
    await http(app)
      .post(`${API_ROOT}/users/search`)
      .send({ query: 'ada' })
      .expect(401);
  });

  async function createUser(
    email: string,
    firstName: string,
    lastName: string,
  ): Promise<void> {
    await http(app)
      .post(`${API_ROOT}/users`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email,
        password: 'E2e-password-1-Strong',
        firstName,
        lastName,
      })
      .expect(201);
  }

  async function login(): Promise<string> {
    const response = await http(app)
      .post(`${API_ROOT}/auth/login`)
      .send({
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASSWORD,
      })
      .expect(200);

    return response.body.data.accessToken as string;
  }
});
