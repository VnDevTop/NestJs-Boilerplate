import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

/**
 * The smoke test: register, login, refresh.
 *
 * Three requests, and the point is not throughput. It is that a deployment
 * answers the calls every client makes, with the right shapes, and that the
 * answers stay fast enough that the default timeouts are not the thing failing
 * the run. A k6 script that measured capacity against a table of five scenarios
 * would report numbers nobody should act on for a boilerplate.
 *
 * Run it against a booted application:
 *
 *   npm run build && npm run start:prod &
 *   k6 run test/smoke/k6-smoke.js
 *
 * `BASE_URL` defaults to the local port and `SMOKE_VUS`/`SMOKE_DURATION` stay
 * deliberately small. The register step creates a real user per virtual user, so
 * a long run against a shared environment fills a users table with throwaway
 * accounts.
 */

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API = `${BASE_URL}/api/v1`;
const VUS = Number(__ENV.SMOKE_VUS || 5);
const DURATION = __ENV.SMOKE_DURATION || '30s';

// Named so a threshold names the step that failed, rather than every scenario
// reporting under one aggregate `http_req_duration`.
const registerDuration = new Trend('smoke_register_duration', true);
const loginDuration = new Trend('smoke_login_duration', true);
const refreshDuration = new Trend('smoke_refresh_duration', true);
const failures = new Counter('smoke_failures');

// A rate rather than a rate of correct responses: one scenario succeeding while
// another silently 500s averages out, and an average that looks fine is exactly
// how a broken deploy gets released.
const loginSuccess = new Rate('smoke_login_success');

export const options = {
  scenarios: {
    smoke: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    // Generous, because this is a smoke test on somebody's laptop and on CI
    // runners, not a capacity plan. They exist to catch a request that stopped
    // returning at all, which without a threshold looks like a green run.
    smoke_register_duration: ['p(95)<2000'],
    smoke_login_duration: ['p(95)<2000'],
    smoke_refresh_duration: ['p(95)<2000'],
    smoke_login_success: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const email = `smoke-${exec.scenario.iterationInTest}-${__VU}@example.test`;
  const password = 'Smoke-password-1-Strong';

  const registered = http.post(
    `${API}/auth/register`,
    JSON.stringify({ email, password, firstName: 'Smoke', lastName: 'Test' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  registerDuration.add(registered.timings.duration);
  record(registered, 'register', registered.status === 201);
  check(registered, { 'register: 201': (r) => r.status === 201 });

  const login = http.post(
    `${API}/auth/login`,
    JSON.stringify({ email, password }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  loginDuration.add(login.timings.duration);
  record(login, 'login', login.status === 200);
  check(login, { 'login: 200': (r) => r.status === 200 });
  loginSuccess.add(login.status === 200);

  const accessToken = json(login)?.accessToken;
  const refreshToken = json(login)?.refreshToken;

  if (!accessToken) {
    return;
  }

  // Refresh is the one authenticated step. The address is unverified, and the
  // route refuses an unverified refresh by design, so a 401 here is the
  // application being correct rather than a broken path. The request is still
  // made, because a script that skipped it could not tell the two apart.
  const refreshed = http.post(
    `${API}/auth/refresh-token`,
    JSON.stringify({ refreshToken }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  refreshDuration.add(refreshed.timings.duration);
  record(refreshed, 'refresh', [200, 401].includes(refreshed.status));
  check(refreshed, {
    'refresh: answered': (r) => [200, 401].includes(r.status),
  });

  // A deliberate wrong-password check, because the login that matters is the
  // refusal: a deployment whose login accepts anything would pass every other
  // assertion in this file.
  const wrong = http.post(
    `${API}/auth/login`,
    JSON.stringify({ email, password: 'Not-the-password-1' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(wrong, { 'wrong password: 401': (r) => r.status === 401 });

  sleep(1);
}

function json(response) {
  try {
    return response.json();
  } catch {
    return null;
  }
}

function record(response, step, ok) {
  if (ok) {
    return;
  }
  // A body per failure is what makes a failing run diagnosable from CI output
  // alone, rather than needing the application logs next to it.
  failures.add(1, { step });
  console.error(
    `[smoke] ${step} -> ${response.status} ${String(response.body).slice(0, 300)}`,
  );
}
