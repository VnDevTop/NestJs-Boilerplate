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
import { OPTIONAL_PACKAGES } from '../../src/core/optional/optional-packages.js';
import { isOptionalAvailable } from '../../src/core/optional/optional.util.js';
import { MailService } from '../../src/modules/mail/mail.service.js';
import { MemoryMailTransport } from '../../src/modules/mail/transports/memory.transport.js';
import { JOB_QUEUE } from '../../src/modules/queue/queue.module.js';
import type { JobQueue } from '../../src/modules/queue/queue.interface.js';

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

    // `data`, because the response interceptor wraps every success body. Reading
    // the bare payload would assert against an application that does not exist.
    expect(response.body.data).toMatchObject({ status: expect.any(String) });
    expect(response.body.success).toBe(true);
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

  it('boots with the queue switched on, whichever driver it can get', () => {
    // Not an assertion about *which* driver, because that depends on whether
    // `bullmq` is installed — and it is, as a dev dependency, precisely so the
    // adapter is tested against the real library. The branch where the package
    // cannot be resolved cannot be taken from inside a process where it can:
    // `queue.module.ts` chooses it, and there is no environment variable that
    // pretends the package is missing. `bullmq.dispatcher.spec.ts` covers that
    // branch directly.
    //
    // What is worth asserting here is the shape of the promise: a queue either way,
    // and the app serving traffic regardless of which one it got.
    const queue = app.get<{ driver: string }>(JOB_QUEUE);

    expect(['bullmq', 'in-process']).toContain(queue.driver);
  });

  it('runs a mail job through whichever driver it got', async () => {
    // The claim that matters is not which driver, but that the work ran at all.
    // A queue whose enqueue resolves and drops the job would answer everything
    // else in this file and still lose every email.
    const queue = app.get<{ driver: string; enqueue: JobQueue['enqueue'] }>(
      JOB_QUEUE,
    );

    await expect(
      queue.enqueue('mail', {
        name: 'mail.send',
        payload: {
          to: 'job-probe@example.test',
          template: 'welcome',
          data: { firstName: 'Job', appName: 'Boilerplate E2E' },
        },
      }),
    ).resolves.toBeUndefined();

    await waitFor(
      async () =>
        (
          await dataSource.query(`SELECT 1 FROM mail_logs WHERE "to" = $1`, [
            'job-probe@example.test',
          ])
        ).length > 0,
      { description: 'the enqueued mail to be sent' },
    );
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

    // Polled rather than read straight away: mail is enqueued, and the in-process
    // dispatcher resolves its enqueue before it runs the job. Reading on the next
    // line is a race that passes on a fast laptop and fails in CI.
    await waitFor(
      async () => (await mailTemplates(dataSource)).includes('welcome'),
      {
        description: 'the welcome mail to be recorded',
      },
    );

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
