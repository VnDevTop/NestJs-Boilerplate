import { randomUUID } from 'node:crypto';

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
  e2eSetting,
  http,
  promoteToSuperAdmin,
  seedAdmin,
  waitFor,
} from './harness.js';
import { Role } from '../../src/common/enums/index.js';
import { authUserKey } from '../../src/core/cache/index.js';
import { DEFAULT_TENANT_ID } from '../../src/common/tenancy/tenant.constants.js';

/**
 * The proof that one tenant cannot read or write another tenant's rows.
 *
 * **Run only in the third mode.** With RLS off, the application's filters are
 * the only thing standing between tenants, and the repository scope is not
 * adopted everywhere yet. With RLS on and the application connecting as
 * `app_user`, a forgotten scope is an empty result rather than a leak — which
 * is exactly the failure this suite is here to catch.
 *
 * The owner connection is used for setup and for assertions that must see both
 * tenants. Every request goes through the application, as `app_user`.
 */
describe.skipIf(!e2eEnabled() || e2eSetting('DATABASE_RLS') !== 'true')(
  'tenant isolation (e2e)',
  () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let redis: RedisClientType;

    const betaId = randomUUID();
    const betaSlug = 'beta';
    const password = 'E2e-password-1-Strong';

    let defaultAdminToken: string;
    let betaAdminToken: string;
    let defaultUserToken: string;
    let defaultUserId: string;
    let betaAdminId: string;

    const defaultUserEmail = 'default-user@example.test';
    const betaUserEmail = 'beta-user@example.test';
    const betaAdminEmail = 'beta-admin@example.test';

    beforeAll(async () => {
      applyE2eEnvironment();
      process.env.QUEUE_ENABLED = 'false';

      const booted = await boot();
      app = booted.app;
      dataSource = booted.dataSource;

      await cleanState(booted);
      await seedAdmin(dataSource);

      // The registry row is written by an operator or a provisioning service,
      // not by a tenant's own request. The owner connection is the right tool.
      await dataSource.query(
        `INSERT INTO tenants (id, slug, name, status, plan) VALUES ($1, $2, $3, 'active', 'free')`,
        [betaId, betaSlug, 'Beta tenant'],
      );

      // The permission catalogue is cloned per tenant. Re-running the seeder is
      // what gives beta the same role definitions as default.
      await seedAdmin(dataSource);
      await promoteToSuperAdmin(dataSource, process.env.ADMIN_EMAIL!);

      await register(defaultUserEmail, 'default');
      await register(betaUserEmail, betaSlug);
      await register(betaAdminEmail, betaSlug);

      await dataSource.query(
        `UPDATE users SET "isEmailVerified" = true, "emailVerifiedAt" = now() WHERE "tenantId" = $1`,
        [DEFAULT_TENANT_ID],
      );
      await dataSource.query(
        `UPDATE users SET "isEmailVerified" = true, "emailVerifiedAt" = now() WHERE "tenantId" = $1`,
        [betaId],
      );
      await dataSource.query(
        `UPDATE users SET role = $1, "isManager" = true WHERE email = $2 AND "tenantId" = $3`,
        [Role.SuperAdmin, betaAdminEmail, betaId],
      );

      defaultAdminToken = await login(
        process.env.ADMIN_EMAIL!,
        'default',
        process.env.ADMIN_PASSWORD!,
      );
      betaAdminToken = await login(betaAdminEmail, betaSlug);
      defaultUserToken = await login(defaultUserEmail, 'default');

      defaultUserId = await idOf(defaultUserEmail, DEFAULT_TENANT_ID);
      betaAdminId = await idOf(betaAdminEmail, betaId);

      const { createClient } = await import('redis');
      redis = createClient({ url: process.env.CACHE_URL }) as RedisClientType;
      await redis.connect();
    });

    afterAll(async () => {
      await redis?.quit();
      await app?.close();
    });

    it('lists only the caller’s tenant', async () => {
      const own = await listUsers(defaultAdminToken, 'default');
      const other = await listUsers(betaAdminToken, betaSlug);

      expect(own).toContain(defaultUserEmail);
      expect(own).not.toContain(betaUserEmail);

      expect(other).toContain(betaUserEmail);
      expect(other).not.toContain(defaultUserEmail);
    });

    it('refuses to read another tenant’s user', async () => {
      const response = await http(app)
        .get(`${API_ROOT}/users/${defaultUserId}`)
        .set('x-tenant-id', betaSlug)
        .set('Authorization', `Bearer ${betaAdminToken}`);

      expect(response.status).toBe(404);
    });

    it('refuses to update another tenant’s user, and changes nothing', async () => {
      const response = await http(app)
        .patch(`${API_ROOT}/users/${defaultUserId}`)
        .set('x-tenant-id', betaSlug)
        .set('Authorization', `Bearer ${betaAdminToken}`)
        .send({ firstName: 'Crossed' });

      expect(response.status).toBe(404);

      const [row] = await dataSource.query<[{ firstName: string }]>(
        'SELECT "firstName" FROM users WHERE id = $1',
        [defaultUserId],
      );

      expect(row.firstName).not.toBe('Crossed');
    });

    it('refuses to delete another tenant’s user, and leaves it there', async () => {
      const response = await http(app)
        .delete(`${API_ROOT}/users/${defaultUserId}`)
        .set('x-tenant-id', betaSlug)
        .set('Authorization', `Bearer ${betaAdminToken}`);

      expect(response.status).toBe(404);

      const [row] = await dataSource.query<[{ deletedAt: Date | null }]>(
        'SELECT "deletedAt" FROM users WHERE id = $1',
        [defaultUserId],
      );

      expect(row.deletedAt).toBeNull();
    });

    it('searches only the caller’s tenant', async () => {
      const response = await http(app)
        .post(`${API_ROOT}/users/search`)
        .set('x-tenant-id', betaSlug)
        .set('Authorization', `Bearer ${betaAdminToken}`)
        .send({ query: `email:${defaultUserEmail}` });

      expect(response.status).toBe(200);

      expect(
        (response.body.data.items as Array<{ email: string }>).map(
          (item) => item.email,
        ),
      ).not.toContain(defaultUserEmail);
    });

    it('exports only the caller’s own rows', async () => {
      const response = await http(app)
        .get(`${API_ROOT}/users/me/export?format=json`)
        .set('Authorization', `Bearer ${defaultUserToken}`);

      expect(response.status).toBe(200);

      expect(response.text).toContain(defaultUserEmail);
      expect(response.text).not.toContain(betaUserEmail);
    });

    it('writes background work to the tenant that asked for it', async () => {
      // Registration enqueues its verification mail. Finding it under beta is
      // what proves the job ran in the tenant that enqueued it rather than as the
      // default tenant.
      await waitFor(
        async () => {
          const [row] = await dataSource.query<[{ count: string }]>(
            'SELECT count(*)::text AS count FROM mail_logs WHERE "to" = $1 AND "tenantId" = $2',
            [betaUserEmail, betaId],
          );

          return Number(row.count) > 0;
        },
        { description: 'beta tenant mail log' },
      );

      const [wrong] = await dataSource.query<[{ count: string }]>(
        'SELECT count(*)::text AS count FROM mail_logs WHERE "to" = $1 AND "tenantId" = $2',
        [betaUserEmail, DEFAULT_TENANT_ID],
      );

      expect(Number(wrong.count)).toBe(0);
    });

    it('reads only the caller’s audit entries', async () => {
      const created = await http(app)
        .post(`${API_ROOT}/users`)
        .set('Authorization', `Bearer ${defaultAdminToken}`)
        .send({
          email: 'audited-default@example.test',
          password,
          firstName: 'Audited',
          lastName: 'Default',
        });

      expect(created.status).toBe(201);
      const defaultTarget = created.body.data.id as string;

      const createdBeta = await http(app)
        .post(`${API_ROOT}/users`)
        .set('x-tenant-id', betaSlug)
        .set('Authorization', `Bearer ${betaAdminToken}`)
        .send({
          email: 'audited-beta@example.test',
          password,
          firstName: 'Audited',
          lastName: 'Beta',
        });

      expect(createdBeta.status).toBe(201);
      const betaTarget = createdBeta.body.data.id as string;

      await waitFor(
        async () => {
          const [row] = await dataSource.query<[{ count: string }]>(
            `SELECT count(*)::text AS count FROM audit_logs WHERE action = 'users.create' AND "targetId" = $1`,
            [betaTarget],
          );

          return Number(row.count) > 0;
        },
        { description: 'beta tenant audit row' },
      );

      const betaTrail = await http(app)
        .get(`${API_ROOT}/admin/audit?action=users.create`)
        .set('x-tenant-id', betaSlug)
        .set('Authorization', `Bearer ${betaAdminToken}`);

      expect(betaTrail.status).toBe(200);

      const targets = (betaTrail.body.data as Array<{ targetId: string }>).map(
        (entry) => entry.targetId,
      );

      expect(targets).toContain(betaTarget);
      expect(targets).not.toContain(defaultTarget);
    });

    it('keeps the cache entries in each tenant’s namespace', async () => {
      await http(app)
        .get(`${API_ROOT}/auth/me`)
        .set('Authorization', `Bearer ${defaultUserToken}`);

      await http(app)
        .get(`${API_ROOT}/auth/me`)
        .set('x-tenant-id', betaSlug)
        .set('Authorization', `Bearer ${betaAdminToken}`);

      const prefix = process.env.CACHE_KEY_PREFIX;

      expect(
        await redis.exists(
          `${prefix}:${DEFAULT_TENANT_ID}:${authUserKey(defaultUserId)}`,
        ),
      ).toBe(1);
      expect(
        await redis.exists(`${prefix}:${betaId}:${authUserKey(betaAdminId)}`),
      ).toBe(1);
    });

    async function register(email: string, tenant: string): Promise<void> {
      const response = await http(app)
        .post(`${API_ROOT}/auth/register`)
        .set('x-tenant-id', tenant)
        .send({ email, password, firstName: 'E2e', lastName: 'User' });

      expect(response.status).toBe(201);
    }

    async function login(
      email: string,
      tenant: string,
      secret: string = password,
    ): Promise<string> {
      const response = await http(app)
        .post(`${API_ROOT}/auth/login`)
        .set('x-tenant-id', tenant)
        .send({ email, password: secret });

      expect(response.status).toBe(200);

      return response.body.data.accessToken as string;
    }

    async function listUsers(token: string, tenant: string): Promise<string[]> {
      const response = await http(app)
        .get(`${API_ROOT}/users?limit=100`)
        .set('x-tenant-id', tenant)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);

      return (response.body.data as Array<{ email: string }>).map(
        (user) => user.email,
      );
    }

    async function idOf(email: string, tenantId: string): Promise<string> {
      const [row] = await dataSource.query<[{ id: string }]>(
        'SELECT id FROM users WHERE email = $1 AND "tenantId" = $2',
        [email, tenantId],
      );

      return row.id;
    }
  },
);
