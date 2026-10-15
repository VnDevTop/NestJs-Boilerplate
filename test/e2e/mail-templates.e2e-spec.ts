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
  seedAdmin,
} from './harness.js';
import { MailTemplateStore } from '../../src/modules/mail/mail-template.store.js';

/**
 * The database override, against a real Postgres.
 *
 * Everything else about this phase is unit-tested against a fake repository, which
 * means the parts that only exist in the database are untested there: the unique
 * index that makes `findOneBy` a correct read rather than an arbitrary one, the
 * transaction that writes the version history, and the `{{ }}` escaping the column
 * stores as text.
 *
 * A fake `insert` cannot catch a column that does not exist in the schema, and this
 * feature's entire failure mode is a template that renders wrong rather than one
 * that throws.
 */
describe.skipIf(!e2eEnabled())('mail template override (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let store: MailTemplateStore;

  beforeAll(async () => {
    applyE2eEnvironment();
    process.env.QUEUE_ENABLED = 'false';

    const booted = await boot();
    app = booted.app;
    dataSource = booted.dataSource;

    await cleanState(booted);
    await seedAdmin(dataSource);
    await promoteToSuperAdmin(dataSource, process.env.ADMIN_EMAIL!);

    store = app.get(MailTemplateStore);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('renders the shipped file while the table is empty', async () => {
    const rendered = await store.render('welcome', {
      firstName: 'Ada',
      appName: 'Boilerplate',
    });

    expect(rendered.subject).toBe('Welcome to Boilerplate');
  });

  it('renders the stored row once one is written', async () => {
    await store.save({
      name: 'welcome',
      subject: 'Edited subject {{appName}}',
      text: 'Edited text for {{firstName}}',
      html: '<p>Edited body for {{firstName}}</p>',
      updatedBy: null,
    });

    const rendered = await store.render('welcome', {
      firstName: 'Grace',
      appName: 'Boilerplate',
    });

    expect(rendered.subject).toBe('Edited subject Boilerplate');
    expect(rendered.text).toContain('Edited text for Grace');
    expect(rendered.html).toContain('Edited body for Grace');
  });

  it('escapes an interpolated field through the real column', async () => {
    await store.save({
      name: 'welcome',
      subject: 'S',
      text: 'T',
      html: '<p>{{firstName}}</p>',
      updatedBy: null,
    });

    const rendered = await store.render('welcome', {
      firstName: '<script>alert("x")</script>',
      appName: 'Boilerplate',
    });

    // The escaping happened when the template was compiled, not when it was written,
    // so this is asserting the whole chain: the column stored the source verbatim and
    // the compiler escaped it on the way out.
    expect(rendered.html).not.toContain('<script>');
  });

  it('keeps the version an edit replaced', async () => {
    const [row] = await dataSource.query<[{ version: number }]>(
      'SELECT "version" FROM email_templates WHERE name = $1 AND locale = $2',
      ['welcome', 'en'],
    );

    // Two saves so far. The first creates the row at version 1 and the second
    // replaces it, so the current version is 2 and one history row exists — a
    // create does not archive a version of the template that did not exist yet.
    expect(row.version).toBe(2);

    const history = await dataSource.query<[{ version: number }]>(
      'SELECT "version" FROM mail_template_versions WHERE name = $1 ORDER BY "version"',
      ['welcome'],
    );

    expect(history.map((entry) => entry.version)).toEqual([1]);
  });

  it('goes back to the shipped file on reset', async () => {
    await store.reset('welcome');

    const rendered = await store.render('welcome', {
      firstName: 'Ada',
      appName: 'Boilerplate',
    });

    // A delete rather than a copy of the file's contents into the row, which is what
    // makes a later change to the file take effect.
    expect(rendered.subject).toBe('Welcome to Boilerplate');
  });

  it('serves the stored template over http through the admin route', async () => {
    const login = await http(app)
      .post(`${API_ROOT}/auth/login`)
      .send({
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASSWORD,
      })
      .expect(200);

    await expectStatus(
      http(app)
        .put(`${API_ROOT}/admin/mail-templates/welcome`)
        .set('Authorization', `Bearer ${login.body.data.accessToken}`)
        .send({
          subject: 'Over http',
          text: 'text over http',
          html: '<p>html over http</p>',
        }),
      200,
      'store a template over http',
    );

    // The point of the route: an edit made here has to reach the next send, with no
    // deploy and no waiting out a TTL.
    const rendered = await store.render('welcome', {
      firstName: 'Ada',
      appName: 'Boilerplate',
    });

    expect(rendered.subject).toBe('Over http');
  });

  it('refuses an unsafe template over http, so nothing reaches the column', async () => {
    const login = await http(app)
      .post(`${API_ROOT}/auth/login`)
      .send({
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASSWORD,
      })
      .expect(200);

    await http(app)
      .put(`${API_ROOT}/admin/mail-templates/welcome`)
      .set('Authorization', `Bearer ${login.body.data.accessToken}`)
      .send({
        subject: 'S',
        text: 'T',
        html: '<p>{{{firstName}}}</p>',
      })
      .expect(400);

    const [row] = await dataSource.query<[{ html: string }]>(
      'SELECT "html" FROM email_templates WHERE name = $1 AND locale = $2',
      ['welcome', 'en'],
    );

    // The previous test's wording is still there, which is what "refused" has to
    // mean: the row was not replaced by something unsafe.
    expect(row.html).not.toContain('{{{');
  });
});

async function expectStatus(
  pending: ReturnType<ReturnType<typeof http>['put']>,
  expected: number,
  what: string,
): Promise<void> {
  const response = await pending;

  expect(response.status, `${what}: ${JSON.stringify(response.body)}`).toBe(
    expected,
  );
}
