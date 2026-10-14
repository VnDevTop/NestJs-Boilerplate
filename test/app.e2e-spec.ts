import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';

import { API_ROOT, boot, e2eEnabled, http } from './e2e/harness.js';

/**
 * The smoke test: the application boots against real containers and answers on
 * the route prefix a client actually uses.
 *
 * It replaces the stock `Hello World` assertion, which passed against a broken
 * prefix as long as the root path happened to work. Nothing here creates rows, so
 * it is safe to run before the suites that do.
 */
describe.skipIf(!e2eEnabled())('application (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await boot());
  });

  afterAll(async () => {
    await app?.close();
  });

  it('answers the versioned root', async () => {
    await http(app).get(API_ROOT).expect(200);
  });

  it('reports health on the versioned prefix', async () => {
    const response = await http(app).get(`${API_ROOT}/health`).expect(200);

    // `data`, because the response interceptor wraps every success body. Reading
    // the bare payload would pass only if the wrapper were gone — which is the
    // opposite of what this suite is checking.
    expect(response.body.data.status).toMatch(/ok|degraded/);
    expect(response.body.success).toBe(true);
  });

  it('refuses an unknown path with a 404 rather than hanging', async () => {
    await http(app).get(`${API_ROOT}/definitely-not-a-route`).expect(404);
  });
});
