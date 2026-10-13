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
} from './harness.js';
import { OPTIONAL_PACKAGES } from '../../src/core/optional/optional-packages.js';
import { isOptionalAvailable } from '../../src/core/optional/optional.util.js';
import { MailService } from '../../src/modules/mail/mail.service.js';
import { MemoryMailTransport } from '../../src/modules/mail/transports/memory.transport.js';
import { InProcessDispatcher } from '../../src/modules/queue/in-process.dispatcher.js';
import { JOB_QUEUE } from '../../src/modules/queue/queue.module.js';

/**
 * The suite that boots the application the way a fresh clone does.
 *
 * This repository ships no `optionalDependencies`, which is the state every row
 * of the integration matrix has to survive. The tempting way to test that would
 * be to move the packages there and let npm skip them, but npm installs them
 * whenever they resolve, so the test would pass on a machine with a warm
 * lockfile cache and prove nothing on the machine that needed it.
 *
 * What is asserted instead is the property the design actually promises: every
 * feature reaches a working fallback when its package is absent, and the
 * application keeps serving traffic while it does.
 */
describe.skipIf(!e2eEnabled())('empty optional dependencies (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    applyE2eEnvironment();
    // A provider nobody installed, asked for by name: the exact shape of a deploy
    // that set the flag and forgot the install.
    process.env.MAIL_TRANSPORT = 'ses';
    // Enabled with the queue url present. The module has to choose the in-process
    // driver and say so, not refuse to boot.
    process.env.QUEUE_ENABLED = 'true';

    const booted = await boot();
    app = booted.app;
    dataSource = booted.dataSource;

    await cleanState(booted);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('reports every optional package as absent', () => {
    for (const [name, pkg] of Object.entries(OPTIONAL_PACKAGES)) {
      // bullmq is a dev dependency here on purpose: the queue adapter has to be
      // tested against the real library, because one that has never run is one
      // that is broken. Everything else is genuinely missing.
      if (name === 'bullmq') {
        continue;
      }

      expect(
        isOptionalAvailable(pkg.specifier),
        `${name} (${pkg.specifier}) should not resolve`,
      ).toBe(false);
    }
  });

  it('boots and serves health', async () => {
    const response = await http(app).get(`${API_ROOT}/health`).expect(200);

    expect(response.body).toMatchObject({ status: expect.any(String) });
  });

  it('falls back to the memory transport instead of failing to send', async () => {
    expect(app.get('MAIL_TRANSPORT')).toBeInstanceOf(MemoryMailTransport);

    const result = await app
      .get(MailService)
      .sendTemplate('degraded@example.test', 'welcome', {
        firstName: 'Degraded',
        appName: 'Boilerplate E2E',
      });

    // `delivered` is true because the memory transport accepts. The assertion
    // worth making is the second one: the caller can see which transport ran, so
    // a deployment that asked for SES cannot read a green log as proof it used
    // SES.
    expect(result.delivered).toBe(true);
    expect(result.transportName).toBe('memory');
  });

  it('falls back to the in-process dispatcher', () => {
    expect(app.get(JOB_QUEUE)).toBeInstanceOf(InProcessDispatcher);
  });

  it('records a registration mail row rather than losing the message', async () => {
    // The row is where `docs/runbook.md` sends an operator when a user reports a
    // missing email, so it has to exist even when the provider package does not.
    await http(app)
      .post(`${API_ROOT}/auth/register`)
      .send({
        email: 'optional-deps@example.test',
        password: 'E2e-password-1-Strong',
        firstName: 'Optional',
        lastName: 'Deps',
      })
      .expect(201);

    const rows = await dataSource.query(
      'SELECT template, transport, delivered FROM mail_logs',
    );

    expect(rows).toContainEqual(
      expect.objectContaining({
        template: 'welcome',
        transport: 'memory',
        delivered: true,
      }),
    );
  });

  it('still writes through the database, which is not optional', async () => {
    const [row] = await dataSource.query<[{ count: string }]>(
      'SELECT count(*)::text AS count FROM users WHERE email = $1',
      ['optional-deps@example.test'],
    );

    expect(row.count).toBe('1');
  });
});
