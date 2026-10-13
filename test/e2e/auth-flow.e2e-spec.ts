import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { hashToken } from '../../src/common/utils/index.js';

import {
  API_ROOT,
  applyE2eEnvironment,
  boot,
  cleanState,
  e2eEnabled,
  http,
} from './harness.js';

const EMAIL = 'auth-flow@example.test';
const PASSWORD = 'E2e-password-1-Strong';

/**
 * The three requests every client makes, end to end, over the wire.
 *
 * The unit suite covers the rotation rules and the reuse signal in detail. What
 * it cannot cover is that the routes are reachable, that the response shape a
 * client depends on is what the DTO says, and that a verified address is
 * actually reachable end to end — which is why the verification token is
 * extracted from the database here. The alternative, calling the internal
 * service, would test a path no client ever takes.
 */
describe.skipIf(!e2eEnabled())('register, login and refresh (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let accessToken: string;

  beforeAll(async () => {
    applyE2eEnvironment();
    process.env.QUEUE_ENABLED = 'false';

    const booted = await boot();
    app = booted.app;
    dataSource = booted.dataSource;

    await cleanState(booted);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('registers a user and mails a welcome and a verification', async () => {
    const response = await http(app)
      .post(`${API_ROOT}/auth/register`)
      .send({
        email: EMAIL,
        password: PASSWORD,
        firstName: 'Auth',
        lastName: 'Flow',
      })
      .expect(201);

    expect(response.body).toHaveProperty('id');
    // Deliberately not asserting a token here: registration does not sign the
    // new user in, and a client that assumed it did would be a real bug.
    expect(response.body.accessToken).toBeUndefined();

    const templates = await dataSource.query<{ template: string }[]>(
      'SELECT template FROM mail_logs ORDER BY "createdAt"',
    );

    expect(templates.map((row) => row.template)).toEqual(
      expect.arrayContaining(['welcome', 'verify-email']),
    );
  });

  it('verifies the address and signs the user in for real', async () => {
    // The token the mail carried cannot be read back out of a digest, so this
    // plants a token whose plaintext is known. That is the one thing the suite
    // does to the database directly, and it is what makes the rest of the flow
    // the real one: the route, the guard and the refresh rotation are all
    // exercised against a genuinely verified account.
    const [user] = await dataSource.query<[{ id: string }]>(
      'SELECT id FROM users WHERE email = $1',
      [EMAIL],
    );

    const token = 'e2e-verification-token';

    await dataSource.query(
      `INSERT INTO email_verification_tokens
         (id, "userId", "tokenHash", "expiresAt")
       VALUES (gen_random_uuid(), $1, $2, now() + interval '1 hour')`,
      [user.id, hashToken(token)],
    );

    await http(app)
      .post(`${API_ROOT}/auth/verify-email`)
      .send({ token })
      .expect(201);
  });

  it('logs in and returns the documented token pair', async () => {
    const response = await http(app)
      .post(`${API_ROOT}/auth/login`)
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);

    expect(response.body).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
    });

    accessToken = response.body.accessToken;
  });

  it('authenticates the very next request with that access token', async () => {
    const response = await http(app)
      .get(`${API_ROOT}/auth/me`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(response.body.email).toBe(EMAIL);
  });

  it('rotates the refresh token and refuses the one it replaced', async () => {
    const first = await http(app)
      .post(`${API_ROOT}/auth/login`)
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);

    const rotated = await http(app)
      .post(`${API_ROOT}/auth/refresh-token`)
      .send({ refreshToken: first.body.refreshToken })
      .expect(200);

    expect(rotated.body.refreshToken).not.toBe(first.body.refreshToken);

    // Replaying the superseded token is the reuse signal, and it is refused.
    // Over http, with the real table and the real rotation, rather than against
    // a mock that would answer the same either way.
    await http(app)
      .post(`${API_ROOT}/auth/refresh-token`)
      .send({ refreshToken: first.body.refreshToken })
      .expect(401);
  });

  it('refuses a wrong password with the same answer as an unknown address', async () => {
    const wrongPassword = await http(app)
      .post(`${API_ROOT}/auth/login`)
      .send({ email: EMAIL, password: 'Not-the-password-1' })
      .expect(401);

    const unknownAddress = await http(app)
      .post(`${API_ROOT}/auth/login`)
      .send({ email: 'nobody@example.test', password: 'Not-the-password-1' })
      .expect(401);

    // The two answers must be indistinguishable, or the endpoint tells an
    // attacker which addresses are registered.
    expect(unknownAddress.body.message).toBe(wrongPassword.body.message);
  });
});
