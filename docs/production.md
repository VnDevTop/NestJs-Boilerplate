# Production hardening

Everything here is configuration, so it lives in `.env`. See `.env.example` for
the full list with defaults.

## Rate limiting

`@nestjs/throttler`, registered as a global guard, so a new endpoint is limited
from the moment it exists instead of only after someone remembers.

```dotenv
THROTTLE_TTL=60000           # counting window
THROTTLE_LIMIT=100           # requests per window per client
THROTTLE_BLOCK_DURATION=0    # 0 blocks for the rest of the window
```

Credential routes override it with `@Throttle`, because the global number is far
too generous for a route that accepts a password or a six digit code:

| Route                      | Limit                                         | Why                             |
| -------------------------- | --------------------------------------------- | ------------------------------- |
| `POST /auth/login`         | 20 / 5 min per client, 10 / 5 min per address | Password guessing is the threat |
| `POST /auth/2fa/login`     | Same as login                                 | A TOTP code is 1 in a million   |
| `POST /auth/2fa/verify`    | 5 / 5 min                                     | Same, and it is a second factor |
| `POST /auth/register`      | 10 / 5 min                                    | Cheap to call, creates rows     |
| `POST /auth/refresh-token` | 60 / min per client                           | Rotation is a write per call    |

**Two buckets per credential route.** A per-client limit cannot see an attacker
guessing one account from many hosts, and a per-address limit cannot see an
attacker spraying accounts from one host. Both must pass.

**Counters live in Redis, so the limit holds across replicas.** The storage is a
Lua script, because a read followed by a write lets two concurrent requests both
through, which is the burst being defended against.

**It fails open.** A dead Redis means the request is allowed, because failing
closed would make a cache outage an outage of the whole login route. The cost is
that an outage removes the protection exactly when somebody is most likely to be
hammering the endpoint, so put a limit in front of the application too. These are
the inner layer, not the only one.

Which buckets a route gets is opt-in with `@RateLimit('group')`. Every bucket is
declared globally, because the guard builds its list from the module options and
nothing else, and then loops over that whole list on every request. A bucket named
only in `@Throttle()` is never reached, so a per-bucket `skipIf` decides which
routes it applies to.

## Login lockout

Five failed sign-ins block an address for a minute, each further failure adds a
minute, capped at fifteen. Temporary rather than permanent, because a permanent
lockout is a denial of service anyone can inflict on a victim.

- Counts failures for addresses that do not exist too, so a 429 cannot reveal
  which addresses exist.
- Returns 429 with `Retry-After`, and the body does not say how long is left.
- Notifies the owner once per lockout, and never for an unregistered address.
- Fails open, with the rest of the Redis state.

## Data retention

A nightly job deletes rows that can no longer be useful. See
[the maintenance module](../src/modules/maintenance/README.md) for the policy and
the reasoning.

```dotenv
RETENTION_ENABLED=true         # on by default; it only removes rows past their age
RETENTION_DRY_RUN=false        # rehearse before the first production run
RETENTION_SCHEDULE='17 3 * * *' # off-peak minute
RETENTION_BATCH_SIZE=5000      # rows per delete statement
RETENTION_BATCH_DELAY=100      # milliseconds between batches
RETENTION_RUN_TIMEOUT=3600000  # give up rather than run forever
```

| Route                           | What it does                                    |
| ------------------------------- | ----------------------------------------------- |
| `POST /admin/retention/dry-run` | Counts what a run would delete, deletes nothing |
| `POST /admin/retention/run`     | Queues a real run                               |
| `GET /admin/retention/runs`     | The run history                                 |

**The schedule does not catch up a missed run.** If the process is not running at
`RETENTION_SCHEDULE`, that night is skipped and nothing logs an error. Do not
schedule deploys around that minute.

## Security headers

`helmet`, with HSTS on, plus `X-Content-Type-Options`, `X-Frame-Options` and
`Referrer-Policy: no-referrer`.

Content-Security-Policy is **off** by default, because the Swagger UI served at
`/docs` needs inline scripts and styles and a strict policy blocks it. Turn
`SECURITY_CONTENT_SECURITY_POLICY=true` on once a real front end is known, and
serve `/docs` only where that is not a concern.

HSTS does nothing over plain HTTP, so it only takes effect behind TLS, which is
what `includeSubDomains` already assumes.

## CORS

```dotenv
CORS_ORIGINS=https://app.example.com,https://admin.example.com
CORS_CREDENTIALS=false
```

`CORS_CREDENTIALS=false` by default, because this API authenticates with an
`Authorization` header rather than a cookie. Turning it on requires an explicit
allow-list: validation rejects `CORS_CREDENTIALS=true` together with a wildcard
or an empty list, since browsers refuse that combination anyway and a config
that only looks like it works is worse than one that fails loudly.

`X-Request-Id` is exposed so a browser can read it and quote it in a bug report.

## Request id

Every response carries `X-Request-Id`. A client supplied id is reused when it
looks safe: 8 to 64 characters from a restricted charset. An id containing a
newline or a control character is discarded and replaced, because a caller who
can choose the value printed on every log line can forge or split log entries.

The id is held in an `AsyncLocalStorage`, so a log line written deep inside a
service includes it without the call site knowing anything about requests.

## Logging

One JSON object per line in production:

```json
{
  "timestamp": "2026-01-01T00:00:00.000Z",
  "level": "error",
  "context": "CacheModule",
  "requestId": "...",
  "message": "Cache unavailable: connect ECONNREFUSED ..."
}
```

Human readable elsewhere. A message containing newlines is collapsed to a single
line so a stack trace cannot be misread as several entries, and an `Error` is
serialised with its name, message and stack rather than as `{}`.

## Cache and what it holds

Authentication is served from Redis, so an authenticated request costs cache reads
instead of database queries. What that buys is only safe if the cache is dropped
when it should be, so this section is mostly about what has to be dropped.

| Key                       | Holds                                      | TTL                   | Dropped by                                                |
| ------------------------- | ------------------------------------------ | --------------------- | --------------------------------------------------------- |
| `user:<id>`               | the claims a request is authorised against | 60s                   | deactivation, role change, soft delete, revocation        |
| `user:<id>:devices`       | each device's session version              | 60s                   | the same, plus signing out of that device                 |
| `role:<role>`             | the permission names a role holds          | 600s                  | `PUT /admin/roles/:role/permissions`, the permission seed |
| `token:revoked:<session>` | one revoked session                        | access token lifetime | **nothing. See below.**                                   |

```dotenv
CACHE_AUTH_USER_TTL=60       # claims, and the device versions beside them
CACHE_AUTH_ROLE_TTL=600      # one entry per role, not per user
```

**Fail open.** A dead Redis means a miss, so the request falls back to the database
and is slower rather than refused. `/health/ready` reports `degraded` and still
returns 200; `degraded` is a status Terminus knows, and `down` would pull every
instance out of rotation over a cache outage.

**The TTL is a backstop, not the mechanism.** Writes invalidate; the TTL only
bounds how long a _forgotten_ invalidation could hide a change. That is why the
values are configurable rather than constants, and why they are named in the
README.

### The one key that is never invalidated

`token:revoked:<session>` is the record of a revoked session, not a copy of
something in the database. There is no column to re-read it from, because a
revoked session is a `revokedAt` on a row nothing looks up by jti. Deleting it
hands the session back, so it is written directly, with an exact lifetime, and
reclaimed by Redis when the tokens it revokes have expired on their own.

### Changing permissions

Use the route, not SQL:

```text
PUT /admin/roles/:role/permissions     role:write, super administrator only
```

Invalidation runs where the write runs, so an edit made straight in the database
is invisible to the application until the cached grant set expires. The window is
`CACHE_AUTH_ROLE_TTL`, currently ten minutes. Either use the route, delete the
entry, or wait:

```sh
redis-cli DEL nestjs_boiler_plate:role:admin
```

The direction of that failure is the safe one: a role with a stale grant set is
_missing_ a permission, so the guard refuses rather than admits. A deploy that
changes grants the other way, which this cache cannot cause, would be the
dangerous one.

## Health checks

```text
GET /api/v1/health/live    liveness, touches nothing external
GET /api/v1/health/ready   database and cache
GET /api/v1/health         the same as ready
```

Liveness and readiness are separate on purpose. Liveness must stay green while a
dependency is down: a failing liveness probe makes an orchestrator restart every
healthy instance at exactly the wrong moment. Readiness is the one that goes red,
so traffic is diverted without a restart.

The cache check writes a random value and reads it back. A plain read would
report healthy on a dead cache, because cache-manager turns a failing store into
a miss, so "unreachable" and "empty" are indistinguishable. The round trip is
what separates them.

## Graceful shutdown

`app.enableShutdownHooks()`, so SIGTERM lets in-flight requests finish, closes the
database pool and exits on its own. `docker-compose.yml` allows 30 seconds for
that.

`ShutdownService` flips a flag on the first signal and `/health/ready` reports not
ready from then on, so a load balancer stops sending new requests while the
existing ones drain.

## Environment validation

`validateEnvironment` runs before anything connects and reports every problem at
once rather than one per restart:

```text
Invalid environment configuration:
  - DATABASE_URL must use one of: postgres:, postgresql:
  - JWT_SECRET must be at least 32 characters
  - JWT_REFRESH_SECRET still holds the example value
```

Strictness depends on `NODE_ENV`. Locally a placeholder secret is fine, so only
presence is checked. In production secrets must be at least 32 characters and
must not still hold the value from `.env.example`, since that file is in the
repository and a secret in it is not a secret.

## Migrations and seed

```bash
npm run migration:generate   # create a migration from entity changes
npm run migration:run
npm run migration:revert
npm run seed
```

`synchronize` is off. Schema changes go through a reviewed migration, so a
deployment cannot quietly rewrite a production table.

Entities are listed explicitly in `src/database/data-source.ts`, because
`autoLoadEntities` only works inside the Nest container, and a migration that
silently missed an entity would generate an incomplete schema. The initial
migration is qualified with `"public"`; set `DATABASE_SCHEMA` to target another
schema.

The seed creates one admin and is idempotent, so a half finished seed or an
accidental second run neither duplicates the admin nor fails on the unique email.
There is no default password: `ADMIN_PASSWORD` is required and must be at least
12 characters, because an account seeded with a published password is a published
account.

```bash
ADMIN_PASSWORD='choose-something-long' npm run seed
```

## Docker

```bash
cp .env.example .env
docker compose up --build
```

Brings up Postgres and Valkey, runs migrations, then starts the app on port 3000.
The cache is configured with no persistence, so a restart starts cold rather than
resurrecting entries a restart may have made stale.

The image is a two stage build: compiler and dev dependencies stay in the build
stage, and the runtime stage runs as the `node` user with production
dependencies only. Its healthcheck uses the liveness endpoint, so a database
problem cannot make the container look dead and get it restarted.

## CI

`.github/workflows/ci.yml` runs lint, typecheck, test and build on Node 24, then
builds the image. The image is built but not pushed, since publishing needs
registry credentials the template does not assume.
