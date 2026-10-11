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
| `user:<id>:notifications` | a user's notification preferences          | 60s                   | `PATCH /notifications/preferences`                        |
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

## Password policy

Configured entirely by environment; nothing is hard-coded in a DTO.

```dotenv
PASSWORD_MIN_LENGTH=8
PASSWORD_MAX_LENGTH=128
PASSWORD_REQUIRE_LOWERCASE=true
PASSWORD_REQUIRE_UPPERCASE=true
PASSWORD_REQUIRE_NUMBER=true
PASSWORD_REQUIRE_SYMBOL=true
PASSWORD_HISTORY_COUNT=5
PASSWORD_CHECK_BREACH_LIST=false
```

Two defaults worth questioning rather than accepting:

- **All four character classes on, at a minimum of 8, is a weak policy.** The
  classes are individually switchable for exactly that reason. Turning them all
  off and raising `PASSWORD_MIN_LENGTH` to 20 accepts
  `correct horse battery staple` and rejects nothing a composition rule would have
  pushed somebody towards. NIST has recommended against composition rules since
  2016, mostly because they produce `Password1!`.
- **`PASSWORD_MAX_LENGTH` is a bound on work, not on the hash.** scrypt has no
  72-byte truncation, so a megabyte of password is a megabyte of key derivation. The
  default of 128 is comfortable; there is no benefit to a larger one.

### The breach list

`PASSWORD_CHECK_BREACH_LIST=true` queries the Pwned Passwords range API. The
password is SHA-1'd and only the **first five characters** are sent; the service
returns every suffix sharing that prefix and the comparison happens here. The
service never learns which password was asked about.

**It fails open.** An unreachable or rate-limited API logs a warning and lets the
signup through. The alternative makes a third party an availability dependency for
this deployment, which is a considerably worse failure than a user signing up with
a breached password.

**A failed lookup is cached for a minute, a verdict for a month.** Both answers read
as "not breached" to the caller, deliberately, because a check that must not deny
service cannot distinguish them. The TTL difference is what stops a brief outage
from becoming a day of unchecked passwords.

### The password history

`PASSWORD_HISTORY_COUNT` (5 by default) keeps the last N hashes per user and
refuses a password that matches any of them. Only the scrypt hash is stored, in the
same `salt:key` form as `users.password`.

**A check is five scrypt derivations.** There is no faster lookup available — a
password is a password, and the only way to know whether it matches is to derive
each candidate. That is the price of the feature, and the reason the default is five
rather than twenty. Raising it costs a password change proportionally.

**The window is trimmed on every write, not by a nightly job.** The table's size is
always exactly N per user, which is also why it needs no retention rule: the only
thing that removes a row is a newer password pushing it out.

**Setting it to 0 disables the feature completely, including the write.** Storing
credentials for a policy that will never check them is pure risk.

At a reset, the reuse check runs inside the transaction and throws, so a rejected
password leaves the token unspent and the user able to try again.

### The permanent lockout

```dotenv
ACCOUNT_PERMANENT_LOCK_THRESHOLD=20
ACCOUNT_PERMANENT_LOCK_WINDOW_HOURS=24
ACCOUNT_UNLOCK_TOKEN_TTL_HOURS=24
```

A second lockout, past the temporary one above. This one writes `users.lockedAt`
and stays until somebody clears it. They are different features, not one bigger
than the other: the temporary block slows an attack off in Redis, this ends a
sustained one in the database.

**Set the threshold above `LOGIN_MAX_FAILED_ATTEMPTS`, and know that a value at or
below it is treated as disabled.** At the same number the permanent lock fires on
the attempt that also starts a temporary block, and the temporary block lifts on
its own — an account locked and unlocked minutes apart.

**This is a denial-of-service surface, and the only thing bounding it is the
recovery path.** Somebody with a list of addresses can lock every account for
twenty requests each. They cannot keep them locked, because:

- only a **confirmed address** can be locked — an unverified one could never
  receive the unlock link, so locking it would be permanent with no owner able to
  clear it. This is a code invariant, not a setting;
- the owner clears it with an emailed link, which reaches the person _under_
  attack;
- an operator clears it with `PATCH /auth/account/:id/unlock` (`UserWrite`).

What survives all three is a nuisance, on an account that can recover itself. That
is the trade: an account nobody can lock is an account nobody can defend.

**Raise `ACCOUNT_PERMANENT_LOCK_WINDOW_HOURS` above 1 if you want the window to mean
anything.** The failure count in Redis carries an hour ttl, so a default of 24 is
measuring "did the worst of these happen today" rather than "in the last 24
hours" — which is the intended reading, but worth being clear about.

**Clearing a lock resets the Redis failure count too**, which is not optional: the
count is at its maximum at the moment of the lock, so skipping it means the owner
clicks their own link, is told they are unlocked, and is then refused with a 429
for the rest of a temporary block they never knew about.

### The optional strength score

`npm install zxcvbn` adds a 0–4 strength score on top of the configured rules.
Without it the score is skipped rather than treated as zero — otherwise a
deployment that never installed the package would refuse every password as "too
easy to guess". See `docs/optional-integrations.md`.

## Operator notifications

Off by default, and the console channel is on inside it — so the default profile
logs what it would have sent and delivers nothing.

```dotenv
NOTIFICATION_ENABLED=true
NOTIFICATION_CONSOLE_ENABLED=false
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
# Optional per-event forum routing, which overrides TELEGRAM_TOPIC_ID where it names
# TELEGRAM_TOPICS=auth.login.failed=42,auth.2fa.enabled=43
SLACK_ENABLED=true
SLACK_WEBHOOK_URL=
```

Three things to check before trusting a channel:

- **A channel with no credential logs why it is disabled and is dropped.** Silence
  looks exactly like a working integration, so the log line is the difference
  between "quiet" and "misconfigured". `env.validation.ts` also refuses an enabled
  channel with no credential at boot.
- **`NOTIFICATION_EMAIL_ENABLED` needs a real `MAIL_TRANSPORT`.** With `memory` the
  channel reports success and nothing is delivered, which is the same
  "reports success while sending nothing" property production validation already
  refuses for mail.
- **`TELEGRAM_TOPICS` is `event=topicId` pairs.** A malformed pair is dropped and
  the notification lands in the default room rather than the boot failing over a
  routing convenience.

An event nobody hears about is worse than one that failed loudly, so the delivery
log records both. Read it when a channel is quiet:

```sql
SELECT "createdAt", "event", "channel", "delivered", "statusCode", "error"
FROM notification_logs
ORDER BY "createdAt" DESC
LIMIT 50;
```

Rows are removed at `RETENTION_NOTIFICATION_LOGS_DAYS`, 30 by default. That table
holds operator addresses and, for the sign-in events, the attempted address — so the
window is a data-retention decision rather than a housekeeping one.

## The audit trail

`audit_logs` records who did what to which row, from which address, under which
request id, with a before/after diff.

```sql
SELECT "createdAt", "actorEmail", "action", "targetType", "targetId", "outcome"
FROM audit_logs
WHERE "actorId" = '…'
ORDER BY "createdAt" DESC
LIMIT 50;
```

**A password never reaches a row.** An audit diff is built from whatever object
the action was performed on, and that object is usually a `User` — which carries a
scrypt hash. `AuditService` walks every diff on the way in and replaces the value
of any key in its redaction list with `[redacted]`, at any nesting depth. The key
stays, so "the password changed" is still readable.

**The writer never throws.** An audit write that failed the action it was recording
would mean an outage in the log turns into an outage in the product. The gap is
logged at `error` instead. This is a deliberate trade: the trail can have holes,
and it is the trail that is available during the incident rather than the one that
proves what happened six months later.

**No foreign keys on the actor or the target.** The right-to-erasure flow removes
the row an audit entry is about; a key would block that erasure or cascade the
evidence away with it.

**`RETENTION_AUDIT_LOGS_DAYS` defaults to 365**, where every other retention
window is a week. An audit trail kept for a month is not an audit trail, and this
is the largest table the nightly job will hold. Size for it before raising it.

**Only some routes are recorded.** `@Audited()` is opt-in, because a trail that
records every request is one nobody reads — profile reads and sign-ins would bury
the privileged writes. The routes that carry it are the ones that change something
or grant access: creating, editing and deleting a user, and replacing a role's
permissions. Adding a new privileged route without the decorator is caught by
`audit-policy.spec.ts`, which reads the decorators off the real handlers.

**A refused request is recorded too**, with the status the exception carried. A
permission that was refused is evidence; one that was never asked for is not.

**`before` is null on every interceptor-written entry.** The interceptor sees the
request and the response, never the row as it was, and a reconstructed before-state
in a table presented as evidence looks like a record while being an inference.
Routes whose before-state matters call `AuditService.record` directly.

**The address comes from `request.ip`**, resolved against the trust proxy setting,
never from `x-forwarded-for` directly — that header is client-controlled and
unbounded, and reading it without the proxy trust setting behind it would put an
attacker's chosen string into the `ipAddress` of every row they created.

See [src/modules/audit/README.md](../src/modules/audit/README.md) for the
indexes and the reasoning.

## Optimistic locking

`users` and `notification_preferences` carry a `@VersionColumn()`.

```text
Two administrators open the same profile.
Admin A saves a role change.       -> version 3 -> 4
Admin B saves a name change.       -> 409, reload
```

**Without it, Admin B's save silently writes the stale role back and both requests
return 200.** That is the failure this prevents, and the reason it matters is that
it is invisible: nobody sees an error, the audit log says the role changed twice,
and the demotion is gone.

`UsersService.update` catches `OptimisticLockVersionMismatchError` and answers
**409**, not 500 — it is a conflict between two requests, not a fault, and a client
that reads 500 retries the save.

**Only those two entities.** Every other table here is written with `insert`,
`delete` or a whole-set replace inside a transaction, so nothing loads a row to edit
it field by field and there is no window for a version to close. A counter on those
would be bumped on writes that never race, and would give a false impression that
the entity is protected.

**Optimistic, not pessimistic.** No row lock is taken; the conflict is detected at
the write. The read-modify-write window here is a person filling in a form, and
holding a lock across that would serialise every editor of every row behind whoever
opened theirs first.

Note that query-builder writes (`repository.update`, `.increment`) bypass the
version check — which is why `lockAccount` uses `save`.

## Idempotency

Mutating routes marked `@Idempotent()` require an `Idempotency-Key` header and
replay the original answer to a retry that reuses it.

```http
POST /api/v1/auth/register
Idempotency-Key: 9f1c2b8e-…
```

**The header is required, not optional.** A route marked with this and called
without it is a 400. Generating a key on the client's behalf would silently promise
a guarantee the caller is not making — the guarantee only works if the _same_ key
comes back on the retry.

**A key already in flight is a 409, not a wait.** Holding a connection open for work
the client cannot cancel means it times out and retries anyway, which is the
situation this exists to survive. The retry is safe: same key, so it gets the
recorded answer.

**A non-2xx answer releases the key rather than recording it.** A 400 for a
validation failure is worth retrying once the client fixes the body; recording it
would replay the rejection for 24 hours to a client that had already corrected what
was wrong.

**Redis down means the request proceeds.** Every mutating request is processed
without the protection — degraded, not broken. Failing closed would trade a partial
loss of a convenience guarantee for a total loss of the product.

Responses over 64 KB are replayed as a status with no body, so a client cannot put
an unbounded value into a keyspace shared with the queue.

Two windows: **60 seconds** to catch a duplicate arriving while the first is still
running, and **24 hours** to serve a retry from a client that was offline.

## Erasure

`POST /api/v1/auth/account/erasure` soft-deletes the caller's account and starts
the `RETENTION_SOFT_DELETED_USERS_DAYS` clock (30 by default).

**A confirmed address is required.** An erasure is not reversible by the person who
asked for it once the grace period ends, so a request from an unverified account is
a request from somebody who cannot prove the inbox is theirs.

**A second request does not restart the clock**, so an account cannot be held in a
half-erased state by asking daily.

**Notification preferences are removed immediately; the user row is not.** A
channel choice is not part of the person, and restoring an account should not
restore "email me about this" for an address that was just erased. There is
deliberately no foreign key from `notification_preferences` to `users` — a cascade
would erase a preference at the moment an operator might be about to restore.

The address in `mail_logs.recipient` is removed by that table's own 30-day window,
not by this flow.

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
