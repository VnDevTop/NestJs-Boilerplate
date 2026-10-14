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
  mailTemplates,
  waitFor,
} from './harness.js';
import { hashToken } from '../../src/common/utils/index.js';

const EMAIL = 'auth-flow@example.test';
const PASSWORD = 'E2e-password-1-Strong';

/**
 * The three requests every client makes, end to end, over the wire.
 *
 * The unit suite covers the rotation rules and the reuse signal in detail. What
 * it cannot cover is that the routes are reachable, that the status codes are
 * the ones a client branches on, and that a verified address is reachable end to
 * end — which is why a token whose plaintext is known is planted here. The
 * alternative, calling the internal service, would test a path no client takes.
 */
describe.skipIf(!e2eEnabled())('register, login and refresh (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

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

  it('registers a user, returns a token pair and mails two messages', async () => {
    const response = await http(app)
      .post(`${API_ROOT}/auth/register`)
      .send({
        email: EMAIL,
        password: PASSWORD,
        firstName: 'Auth',
        lastName: 'Flow',
      })
      .expect(201);

    // Registration signs the user in. It does not verify them, which is the next
    // test — a client that assumed both happened at once would be a real bug.
    expect(response.body.data).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      tokenType: 'Bearer',
    });

    // Mail is queued, so the rows appear after the response has been sent.
    await waitFor(async () => (await mailTemplates(dataSource)).length >= 2, {
      description: 'the welcome and verification mails to be recorded',
    });

    expect(await mailTemplates(dataSource)).toEqual(
      expect.arrayContaining(['welcome', 'verify-email']),
    );
  });

  it('refuses a password the policy rejects', async () => {
    await http(app)
      .post(`${API_ROOT}/auth/register`)
      .send({
        email: 'weak@example.test',
        password: 'password',
        firstName: 'Weak',
        lastName: 'Password',
      })
      .expect(400);

    const [row] = await dataSource.query<[{ count: string }]>(
      'SELECT count(*)::text AS count FROM users WHERE email = $1',
      ['weak@example.test'],
    );

    // The policy runs before the row is created, so nothing is left behind for a
    // signup that was refused.
    expect(row.count).toBe('0');
  });

  it('refuses a verification token it never issued', async () => {
    const [row] = await dataSource.query<[{ tokenHash: string }]>(
      `SELECT "tokenHash" FROM email_verification_tokens LIMIT 1`,
    );

    // 400 rather than 401, and one message for unknown, spent and expired alike:
    // a live token is a credential until it is spent, so telling those apart
    // would leak.
    const response = await http(app)
      .post(`${API_ROOT}/auth/verify-email`)
      .send({ token: row.tokenHash })
      .expect(400);

    expect(response.body.message).toMatch(/invalid or has expired/i);
  });

  it('verifies the address with the token it mailed', async () => {
    // The plaintext of a mailed token cannot be recovered from the digest that
    // was stored, so this plants one. It is the only direct write this suite
    // makes, and it is what makes the rest of the flow the real one: the route,
    // the guard and the rotation all run against a genuinely verified account.
    const token = 'e2e-verification-token';
    const [user] = await dataSource.query<[{ id: string }]>(
      'SELECT id FROM users WHERE email = $1',
      [EMAIL],
    );

    await dataSource.query(
      `INSERT INTO email_verification_tokens (id, "userId", "tokenHash", "expiresAt")
       VALUES (gen_random_uuid(), $1, $2, now() + interval '1 hour')`,
      [user.id, hashToken(token)],
    );

    await http(app)
      .post(`${API_ROOT}/auth/verify-email`)
      .send({ token })
      .expect(202);

    const [verified] = await dataSource.query<[{ verified: boolean }]>(
      'SELECT "isEmailVerified" AS verified FROM users WHERE email = $1',
      [EMAIL],
    );

    expect(verified.verified).toBe(true);
  });

  it('refuses to spend the same verification token twice', async () => {
    await http(app)
      .post(`${API_ROOT}/auth/verify-email`)
      .send({ token: 'e2e-verification-token' })
      .expect(400);
  });

  it('logs in and returns the documented pair', async () => {
    const response = await http(app)
      .post(`${API_ROOT}/auth/login`)
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);

    expect(response.body.data).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
    });
  });

  it('authenticates the next request with that access token', async () => {
    const { body } = await http(app)
      .post(`${API_ROOT}/auth/login`)
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);

    const response = await http(app)
      .get(`${API_ROOT}/auth/me`)
      .set('Authorization', `Bearer ${body.data.accessToken}`)
      .expect(200);

    expect(response.body.data.email).toBe(EMAIL);
  });

  it('rotates the refresh token and refuses the one it replaced', async () => {
    const first = await http(app)
      .post(`${API_ROOT}/auth/login`)
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);

    const rotated = await http(app)
      .post(`${API_ROOT}/auth/refresh-token`)
      .send({ refreshToken: first.body.data.refreshToken })
      .expect(200);

    expect(rotated.body.data.refreshToken).not.toBe(
      first.body.data.refreshToken,
    );

    // Replaying the superseded token is the reuse signal, checked here over http
    // against the real table, rather than against a mock that would answer the
    // same either way.
    await http(app)
      .post(`${API_ROOT}/auth/refresh-token`)
      .send({ refreshToken: first.body.data.refreshToken })
      .expect(401);
  });

  it('answers a wrong password exactly as it answers an unknown address', async () => {
    const wrongPassword = await http(app)
      .post(`${API_ROOT}/auth/login`)
      .send({ email: EMAIL, password: 'Not-the-password-1' })
      .expect(401);

    const unknownAddress = await http(app)
      .post(`${API_ROOT}/auth/login`)
      .send({ email: 'nobody@example.test', password: 'Not-the-password-1' })
      .expect(401);

    // Different answers would tell an attacker which addresses are registered,
    // with no successful guess anywhere in the attempt.
    expect(unknownAddress.body.message).toBe(wrongPassword.body.message);
  });
});
