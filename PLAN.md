# NestJS Boilerplate Implementation Plan

## Goal

Extend the boilerplate from a correct auth skeleton to something a real product
can run on: users get contacted, the database stops growing on its own,
authentication is served from cache, and the app can tell the operator what it
is doing.

The layer boundaries are unchanged. Everything below slots into `configs`,
`database`, `common`, `core` and `modules` as they exist today.

Already built, not rebuilt here:

- JWT auth, refresh rotation, device authentication, two-factor
- RBAC with roles, permissions and manager scope
- `CacheService` with TTL, empty-TTL, coalescing and invalidation helpers
- helmet, CORS allow-list, throttler, Swagger, Observe, Terminus health
- TypeORM migrations, oxlint, vitest, husky, commitlint

Gaps this plan closes:

- Nothing ever emails a user, and there is no password reset or verification.
- Soft-deleted rows and dead tokens accumulate with no retention policy.
- `CacheService` exists but no service reads or invalidates it, so every
  request still goes to Postgres.
- No outbound notification channel, and no visibility into what the app sends.

---

## Phase 12: Optional Integration Foundation

Status: Done

Goal:

Allow an integration to exist in the code without its package existing on disk.
A feature nobody enabled must cost zero dependencies and zero memory.

Tasks:

- [x] Create `src/core/optional/optional.util.ts` with `loadOptional<T>(specifier)`
      using `createRequire(import.meta.url)`
- [x] Never use a static `import` for an optional package; a static import
      breaks the build when the package is missing
- [x] Register every optional integration through a `useFactory` that returns
      `null` when the package is not resolvable
- [x] Make `null` a real, tested code path in every consumer, not a `throw`
- [x] Write the in-house, zero-dependency transports that the default profile
      uses (mail memory transport, Telegram and Slack over raw HTTPS)
- [x] Add `docs/optional-integrations.md`: feature, package, env flag, install command

Integration matrix:

```text
Feature                 Package to install (only if enabled)   Env flag
SMTP (production mail)   nodemailer                            MAIL_TRANSPORT=smtp
Amazon SES              @aws-sdk/client-sesv2                 MAIL_TRANSPORT=ses
SendGrid                @sendgrid/mail                        MAIL_TRANSPORT=sendgrid
BullMQ queue            @nestjs/bullmq + bullmq               QUEUE_ENABLED=true
Telegram                none, raw HTTPS                       TELEGRAM_ENABLED=true
Slack / Discord         none, incoming webhook                SLACK_ENABLED=true
```

Implementation note:

```ts
import { createRequire } from 'node:module';

const requireOptional = createRequire(import.meta.url);

export function loadOptional<T>(specifier: string): T | null {
  try {
    return requireOptional(specifier) as T;
  } catch {
    return null;
  }
}
```

Expected outcome:

- The app boots, passes tests and serves traffic with an empty
  `optionalDependencies`, degrading cleanly instead of crashing.
- Enabling a feature is a documented `npm install` plus an env flag.

Expected commit:

```text
feat: add optional integration foundation
```

---

## Phase 13: Configuration Expansion

Status: Done

Goal:

Add the configuration namespaces the new modules need, with the same
`registerAs` pattern, zod validation and `.env.example` entries the existing
namespaces already have.

Tasks:

- [x] Create `src/configs/mail.config.ts` — transport, from name, reply-to,
      connection options, timeouts
- [x] Create `src/configs/notification.config.ts` — per-channel enable flags
      and credentials
- [x] Create `src/configs/queue.config.ts` — enabled, redis url, attempts,
      backoff, concurrency
- [x] Create `src/configs/retention.config.ts` — every age and batch size
- [x] Create `src/configs/password-policy.config.ts`
- [x] Add `APP_URL` to `app.config.ts`; every email links back to it
- [x] Add a `redis` namespace for queue and throttle usage, distinct from the
      cache namespace so keys never collide
- [x] Extend `env.validation.ts`: in production `MAIL_FROM` is required,
      `MAIL_TRANSPORT` must not be `memory`, `APP_URL` must be an absolute
      https URL
- [x] Document every new variable in `.env.example` and `src/configs/README.md`

Implementation note: a validation rule that only fires in production is
`superRefine` on the zod schema, not a check inside the service, so a bad
deploy fails at boot instead of at the first email.

Expected outcome:

- No hard-coded value anywhere in the new modules.
- A misconfigured production environment is rejected at startup with a message
  naming the variable.

Expected commit:

```text
feat: add mail, notification, queue and retention configuration
```

---

## Phase 14: Outbound Email

Status: Done

Goal:

Deliver transactional email through a swappable transport, with templates
written as plain functions so no template engine dependency is introduced.

Note: templates are deliberately plain functions in this phase, and the ones
shipped in the repository are the only ones that can send. A template engine and
database-managed templates are a separate phase, Phase 22, because they are a
runtime dependency and an admin surface, and neither belongs in the phase whose
job is to make a user receive a welcome email.

Tasks:

- [x] Create `src/modules/mail` with `mail.module.ts`, `mail.service.ts`
- [x] Define `MailTransport { send(message): Promise<SendResult> }` in
      `transports/transport.interface.ts`
- [x] Implement `memory.transport.ts` as the zero-dependency dev default
- [x] Implement `smtp.transport.ts` over the optional `nodemailer`
- [x] Implement `ses.transport.ts` and `sendgrid.transport.ts` over their
      optional packages
- [x] Make `memory` the development default and refuse it in production
- [x] Build `templates/template.registry.ts` mapping a name to
      `{ subject, render(data) }`
- [x] Render both an HTML and a plain-text part for every template
- [x] Give each template exactly the data it needs, never the user entity
- [x] Generate a stable mail id per message, log it, and return it to the caller
- [x] Add `POST /auth/forgot-password`, returning 202 with a generic message
- [x] Add `POST /auth/reset-password`, single-use token, invalidates other
      sessions on success
- [x] Add `POST /auth/verify-email` and `POST /auth/resend-verification`
- [x] Add the `email_verification_tokens` and `password_reset_tokens` entities
- [x] Store tokens hashed with sha256, never in plaintext
- [x] Index `expiresAt` on every token table, Phase 16 cleans on it
- [x] Add a throttler bucket for mail: 3 reset mails per hour per email and
      10 per hour per IP

Template set:

```text
welcome            after register            firstName, appName
verify-email       after register / resend   verificationUrl, expiresInHours
reset-password     forgot password           resetUrl, ip, expiresInMinutes
password-changed   after reset, forced      ip, deviceLabel
new-device-login   refresh from new device   deviceLabel, ip, time
account-locked     lockout or admin action   reason, supportUrl
```

All six exist and are tested. Four are emitted: `verify-email` and
`reset-password` from this phase, `welcome` from the same register call. Three
are rendered but have no caller yet, because the events that need them do not
exist: `password-changed` waits for the forced-change flow, `new-device-login`
for the refresh event, `account-locked` for the lockout, which Phase 19 adds.

Security notes, and where each one landed:

- `forgot-password` answers identically whether or not the email exists. It also
  takes the same time and does the same database work: the miss path runs the
  same statement against an id with no rows, and both paths are held for a fixed
  floor with equal jitter. A matching message alone is not enough, because the
  branch that issues a token is measurably slower. See
  `src/modules/auth/README.md` for why the floor is a mitigation rather than a
  proof.
- The reset token is consumed inside the same transaction that changes the
  password, so a crash can never leave a live token with a changed password. The
  session revocation is in that transaction too.
- `MailService.send()` does not add latency to `register()` or `login()`. The
  send is not awaited, so a provider that hangs cannot hold a request open. It
  still costs two database statements, which Phase 15 removes by queueing.

Security notes that are part of the definition of done:

- `forgot-password` answers identically, with comparable timing, whether or not
  the email exists.
- The reset token is consumed inside the same transaction that changes the
  password, so a crash can never leave a live token with a changed password.
- `MailService.send()` must not add latency to `register()` or `login()`; it
  resolves as soon as the job is accepted.

Expected outcome:

- A new user receives a welcome email, can verify their address, and can reset
  a forgotten password.
- A provider outage degrades to a logged error, never a 500 on register.

Expected commit:

```text
feat: add transactional email with pluggable transports
```

---

## Phase 15: Background Job Queue

Status: Done

Goal:

Move email sending and notifications out of the request cycle, and give the
retention job a scheduler.

Tasks:

- [x] Add `@nestjs/bullmq` as an optional dependency, resolved through
      `loadOptional`, not a static import
- [x] Create `src/modules/queue` with a provider-level abstraction over the
      queue so the module imports cleanly when the package is absent
- [x] Create queues: `mail`, `notification`, `maintenance`, `digest`
- [x] Move the mail send from Phase 14 into `processors/mail.processor.ts`
- [x] Add `retry.policy.ts`: exponential backoff, 5 attempts
- [x] Mark provider 4xx responses as non-retryable, retry only timeouts, 5xx
      and connection errors
- [x] Send exhausted jobs to a dead-letter list in Redis and raise a log alarm
- [x] Add an in-process fallback: when the queue is disabled or Redis is
      unreachable, run the same processor under a bounded concurrency limiter
- [x] Add an idempotency guard, `template + recipient + subject id`, using a
      Redis `SET NX` with a TTL matching the retry window
- [x] Register the cron entry points, disabling them with `QUEUE_ENABLED=false`

Implementation note: the fallback must call the same processor function as the
queue does, so there is one implementation of the work and not two that drift.

What was decided along the way, and why:

- **`bullmq` is a dev dependency, not a runtime one.** The adapter has to be
  tested against the real library; a queue adapter that has never run is one that
  is broken. Production still ships without it unless the queue is enabled.
- **Deduplication sits around the processor, not at `enqueue`.** A queue is
  at-least-once and the duplicate arrives at _execution_. A key is also released
  when a job fails retryably, because holding it would make the retry skip itself,
  bullmq record success, and the mail never be sent. Verified against a real
  redis: a repeated delivery is skipped, and a released key lets the retry run.
- **A redis outage fails open.** Losing a dedupe key risks a duplicate; refusing
  the job would lose a real email.
- **The dead-letter list is redis, not a table.** It is operational data read at
  3am and worthless after a few days; a table would mean something Phase 16 has to
  remember to purge.
- **`ScheduleModule` was added but no cron entry uses it yet.** The only recurring
  work is the retention job, which arrives with Phase 16. Entries will not be
  gated on the queue driver, so they keep running when redis is down.
- **A redis key prefix gap from Phase 12/13 was found and fixed here:** the raw
  client did not namespace keys the way keyv does for the cache, so every dedupe
  and dead-letter key would have been written unprefixed.

Expected outcome:

- `register()` returns without waiting for SMTP.
- A BullMQ redelivery cannot produce a duplicate welcome email.
- Turning the queue off is a config change, not a code change.

Expected commit:

```text
feat: add background job queue with in-process fallback
```

---

## Phase 16: Data Retention and Cleanup

Status: Done

Goal:

Bound the size of the database by deleting data that can no longer be useful,
without ever taking a lock that hurts production traffic.

Tasks:

- [x] Create `src/modules/maintenance` with a `retention.service.ts`
- [x] Implement the policy below, every age configurable
- [x] Add a `maintenance.retention` cron at an off-peak hour, plus an
      admin-triggered manual run
- [x] Delete in batches with `WHERE id IN (SELECT id ... LIMIT 5000)` and a
      sleep between batches
- [x] Log a structured summary of rows deleted per target, and expose the last
      run time and duration
- [x] Add `RETENTION_DRY_RUN` that reports what would be deleted and deletes
      nothing
- [x] Add a hard-coded minimum age guard, so a misconfigured value cannot
      delete fresh data
- [x] Add the `maintenance.log` entity, append-only, to record each run
- [x] Add an admin route to trigger a dry run and to read the history

Retention policy:

```text
Target                        Rule                                    Default
users (soft deleted)          hard delete after deletedAt + N days     30
email_verification_tokens     delete once expiresAt passed            +7 grace
password_reset_tokens         delete once used, or expiresAt + N      +7 grace
refresh_tokens                delete when revokedAt + N, or expired   7
user_devices                  delete when no live refresh token       immediate
mail_logs, notification_logs  delete rows older than N                30
login attempt bookkeeping     delete rows older than N                7
two-factor secrets            cascade with the user delete             -
```

Decisions taken against the policy above:

- `two_factor_secrets` is not a target of its own. Now that it has a cascading
  foreign key, the user delete removes it.
- `mail_logs`, `notification_logs`, login-attempt bookkeeping and `audit_logs`
  stay out of the policy until their tables exist. A rule naming a missing table
  would fail on every run. They are listed in `DEFERRED_TARGETS` so the gap is
  reviewable rather than forgotten.
- The `user_devices` rule does discard the `ipAddress` and `userAgent` of past
  logins along with the row. It returned 2 rows out of 40 on live data, which is
  a cheap trade, and device rows are otherwise bounded by the user count.

Commits:

```text
ce9f119  fix: cascade user devices and two-factor secrets on user delete
2753621  feat: define the retention policy table
62cb57b  feat: add batched retention deletes
c525251  feat: add the maintenance run log
25951e7  feat: add the maintenance job processor
21b9f1c  feat: schedule the retention job
689a76a  feat: expose retention runs to an admin
66d4cf4  docs: mark phase 16 data retention as done
```

What was built:

- `retention.policy.ts` holds the policy as data: one entry per table, each with
  its own predicate. Adding a target is adding an entry, not editing a switch.
- `retention.service.ts` runs it in batches, one transaction per batch, with a
  configurable pause between them. A target that fails is recorded and skipped
  rather than ending the run.
- `retention.processor.ts` runs it as a queue job, so the cron and the admin
  route share one execution path.
- `scheduler/retention.scheduler.ts` enqueues it nightly at `RETENTION_SCHEDULE`,
  through `JOB_QUEUE`, so it fires whether the queue is BullMQ or in-process.
- `admin/retention.controller.ts` exposes a synchronous dry run, a queued real
  run, and the history.

Decisions taken during the work:

- `RETENTION_ENABLED` defaults to `true`. Retention only removes rows already past
  their age, so an unconfigured deployment loses nothing it could still use, and
  defaulting it off would make every install a deployment that grows forever.
- The minimum age guard is enforced at the point of use, not only in environment
  validation, because a config object assembled in a test must not be able to
  delete today's rows.
- A run that hit its timeout stops immediately rather than finishing the batch in
  progress. A timeout here is nearly always a lost database connection, and
  completing the batch would be another round trip against a connection that is
  already gone.
- A run that finished is a job success even when individual targets failed. A
  renamed column answers a retry identically five seconds later. A timeout is the
  opposite and stays retryable, because tables were left unclean.
- `maintenance_logs` carries no index. A run is about 728 bytes stored, so a year
  of daily runs is roughly 260 KB and fits in memory; an index would cost more than
  it saves. Nothing prunes it, and the operator trims by hand.
- The dry run counts exactly, with no cap. A rehearsal that under-reports is worse
  than a slow one.

Known limits:

- The cron does not catch up a missed run. Restarting the app is fine, because the
  schedule is re-registered on every boot and fires at the next occurrence, but a
  window in which the process is not running at `RETENTION_SCHEDULE` means that
  night is skipped entirely and nothing logs an error.
- With the in-process dispatcher, a job that was enqueued but not yet processed is
  lost on restart. With BullMQ it survives in redis, but the worker is created
  lazily on first use, so it waits for the next enqueue to be picked up.
- Several instances each run the schedule, so a night can produce several runs.
  That is accepted: every run is idempotent, and rows are only removed once they
  are already past their age.

Expected outcome:

- Table sizes flatten out under normal traffic instead of growing forever.
- The first production run can be rehearsed safely with a dry run.

---

## Phase 17a: Permission-based Authorization

Status: Done

Goal:

Give the authorization layer an actual permission model. The `@Permissions()`
decorator and `PermissionsGuard` exist, but nothing uses them: there is no
`permissions` table, no `role_permissions` table, and the guard returns true for
any route without permission metadata. This phase builds the data model and makes
the guard enforce it.

This is split out of the original Phase 17 because it is a feature, not a
performance change, and it is releasable on its own. Everything in Phase 17b
caches what this phase defines.

Tasks:

- [x] Add a `Permission` entity: `name` unique, `description`, timestamps
- [x] Add a `RolePermission` entity joining role to permission, unique per pair
- [x] Generate the migration and seed the permission set each role starts with
- [x] Add `permissions` to `RequestUser`, populated by the strategy
- [x] Rewrite `PermissionsGuard` so it checks the user's set, denying by default
      when a route declares permissions and the user has none
- [x] Apply `@Permissions()` to the admin routes that should require one, so the
      decorator has at least one real caller
- [x] Add `GET /auth/sessions`, listing the caller's refresh sessions and devices
- [x] Add `DELETE /auth/sessions/:id`, revoking one session without touching the
      others
- [x] Add a `sessionsVersion` column on `users`, bumped by `logoutAll()` and by
      a password change
- [x] Put `sessionsVersion` in the access token payload and reject a token whose
      claim does not match, so logout-everywhere kills access tokens
- [x] Add a throttler storage adapter over the existing `RedisClientService`, so
      limits hold across replicas instead of resetting per process
- [x] Add throttler buckets for login, two-factor and refresh, keyed per IP and
      per email
- [x] Block login temporarily after repeated failures, the way a desktop OS
      does: five failures block for one minute, each further failure adds a
      minute, capped at fifteen, and the block expires on its own

Implementation note: the token carries `sessionsVersion` rather than the strategy
comparing it against a fresh database read on every request. Reading the column
would cost the query this phase exists to remove, and the claim makes revocation
a comparison rather than a lookup. A token issued before the column existed has
no claim and stays valid, which is correct: it predates the feature.

Implementation note, on the email lookup: `forgot-password`, `resend-verification`
and `verify-email` must keep doing real database work. Caching the email lookup
would make a registered address measurably faster than an unknown one on the
second attempt, which is exactly the account-enumeration oracle the timing floor
in `src/modules/auth/enumeration.spec.ts` exists to close. Only `login` reads
through the cache, and its answer is already identical either way.

Commits:

```text
a781a26  feat: add the permission model
b622927  feat: enforce permissions in the guard
42d75cf  feat: list and revoke sessions
0166711  feat: kill every access token on logout everywhere
80fc63d  feat: share the rate limit across replicas
df3085a  fix: apply the per-address rate limits that were never enforced
b84cc0e  feat: block login temporarily after repeated failures
c3e70c4  docs: mark phase 17a permission authorization as done
```

What was built, and what it turned out to need:

- **`Permission` and `RolePermission` entities**, with `ROLE_PERMISSIONS` as the
  single statement of which role holds what. A plain user holds none, so an
  unseeded permission locks a route rather than unlocking it.
- **`PermissionsGuard`** rewritten to check the caller's set, and `@Permissions()`
  applied to seven routes so the decorator has real callers. It throws a 403
  naming the missing permission instead of returning false.
- **`GET/DELETE /auth/sessions`**, where a session is one live refresh token
  rather than one device, because one device can hold several.
- **`sessionsVersion`** on the user, carried in the access token, so
  logout-everywhere is immediate instead of waiting out the fifteen minute token.
- **A redis rate limit store**, built as a Lua script because a read followed by a
  write lets a concurrent pair both through, which is the burst being defended
  against. It fails open, so a redis outage costs rate limiting rather than login.
- **A temporary login lockout**: five failures block for a minute, each further
  failure adds a minute, and the length stops growing at fifteen.

Three things this phase found rather than built:

- **The per-address rate limits had never run.** `ThrottlerGuard` builds its list
  from the module options and nothing else, so a bucket named only in
  `@Throttle()` metadata is never reached. The three-per-hour mail limit from
  Phase 14 was configured, documented and tested, and enforced nothing. Every
  bucket is now declared globally and gated behind a `@RateLimit` marker, with the
  polarity reversed so an undeclared route is limited by `default` alone.
- **The lockout counts failures for addresses that do not exist.** Counting only
  real accounts would make the 429 answer which addresses exist without a single
  successful guess, which is the question the enumeration floor exists to keep
  closed. The cost is that anybody can lock an address out; the block is short,
  grows with the failures and then stops, which slows that attack further than it
  inconveniences a real person.
- **Jewellery belongs in redis keys as a hash.** The lockout keys carry a digest
  of the address, for the same reason `user:email` does.

Known limits:

- The lockout is per address, not per account row, so it counts attempts against
  addresses nobody registered. That is the price of not leaking existence.
- Nothing prunes the lockout keys. They carry their own expiry, so redis reclaims
  them, but an operator watching key count sees them come and go.
- A single replica serving several processes behind one load balancer still shares
  nothing; the redis store only matters across replicas, which is where the limits
  were previously being reset.

Expected outcome:

- A route can require a named permission, and a user without it is refused.
- A caller can see their own sessions and revoke one.
- Logout everywhere takes effect on the next request rather than at token expiry.
- Rate limits and login blocks hold across every replica.
- Five wrong passwords block that account for a minute, not forever.

---

## Phase 17b: Authentication and Authorization through Cache

Status: Pending

Goal:

Serve authentication from Redis instead of Postgres, while a revoked session or
a changed role still takes effect immediately rather than at TTL expiry.

Tasks:

- [ ] Cache the sanitised user under `user:<id>`, TTL 60s, and read it from
      `JwtStrategy.validate()`
- [ ] Cache the email lookup under `user:email:<hash>`, TTL 300s, for `login`
      only
- [ ] Cache the permission set under `perm:user:<id>`, TTL 60s
- [ ] Cache the role permission map under `role:<role>`, TTL 600s, so a permission
      set is one small read rather than a join per request
- [ ] Make `PermissionsGuard` read the cached set
- [ ] Invalidate on every write to `User`, `Role`, `RolePermission` and device
      state
- [x] ~~Do the invalidation from a TypeORM subscriber in
      `src/database/subscribers/`~~ — dropped, and replaced with a guard test. See
      the note below for the two reasons, both checked against the installed
      TypeORM rather than assumed.
- [ ] Fall back to the database and log only when redis is unreachable, so an
      outage costs latency rather than availability
- [ ] Report cache loss as degraded rather than down in the Terminus indicator

Dropped from the original task list, and why:

- **The invalidation subscriber.** The plan wanted invalidation to live in a
  TypeORM subscriber so it "cannot be forgotten in one of them". Two things make
  that impossible here, both verified in `node_modules` rather than reasoned
  about:

  1. **A subscriber gets no dependency injection.**
     `ConnectionMetadataBuilder.buildSubscribers` instantiates them with
     `new metadata.target()`, so there is no constructor argument to inject
     `CacheService` through, and Nest does not rewrite the options it is given.
     Reaching the cache would need a module-level singleton or a second redis
     client, and a second client has to reproduce the key derivation that
     `CacheService` owns — which is exactly the drift `cache-keys.ts` exists to
     prevent.

  2. **It could not identify the row.** `UpdateQueryBuilder` passes `valuesSet`
     as the event entity, so `update()` and `increment()` deliver
     `{ sessionsVersion: 1 }` with no id; `DeleteQueryBuilder` passes no entity
     at all. Every write whose invalidation matters is a query-builder write, so
     the subscriber would fire on all of them and be able to act on none.

  What replaces it is a guard test, `sessions-version-guard.spec.ts`: a write to
  a revocation-critical column may only appear in a file that also invalidates,
  and the amount must be an increment. Adding a third bump site fails the build
  rather than quietly weakening logout-everywhere. It was checked by planting a
  bump in `DeviceService`, which failed the two relevant tests.

- **`wrapOrLoad()`.** `CacheService.wrap()` already does this: it coalesces
  concurrent callers on the same key and stores a nullish result for `emptyTtl`
  rather than the full TTL. Negative caching therefore arrives with it, and a
  second helper doing the same job is two implementations of one behaviour.
- **`token:revoked:<jti>`.** There is no per-access-token revocation to cache.
  Refresh tokens already carry `revokedAt` in the database, and access tokens die
  through the `sessionsVersion` claim that Phase 17a adds. A cache of revoked ids
  would have nothing to read from.

Implementation note: a stale cache entry is an authorization bug, not a
performance bug. That is why invalidation is explicit at every write and guarded
by a test, why the deletes happen after the transaction rather than inside it, why
TTLs stay short, and why the integration test mutates a user and re-reads
immediately rather than waiting one out.

Commits:

```text
perf: serve authentication from cache
perf: serve authorization from cache
perf: guard the sessions version against an uninvalidate write
perf: report cache loss as degraded
```

Expected outcome:

- An authenticated request costs one redis read instead of one or more postgres
  queries.
- A role change or a remote logout takes effect on the next request.
- A redis outage costs latency, not availability.

---

## Phase 18: Notifications

Status: Pending

Goal:

Send operational and user-facing notifications to Telegram, Slack and other
channels, without adding a dependency for any of them.

Tasks:

- [ ] Create `src/modules/notification` with `notification.service.ts`
- [ ] Define `NotificationChannel { name, isEnabled(), send(n) }`
- [ ] Implement `telegram.channel.ts` over raw HTTPS, no package
- [ ] Implement `slack.channel.ts` over an incoming webhook, no package, with
      Block Kit payloads
- [ ] Implement `discord.channel.ts` on the same webhook shape
- [ ] Implement `email.channel.ts` delegating to `MailService`
- [ ] Implement `console.channel.ts` as the development default
- [ ] Add a per-channel enable flag, retry policy and dead-letter list
- [ ] Make `notify()` asynchronous and failure-isolated; a broken webhook must
      never fail a registration
- [ ] Add `notification_preferences` so a user can opt out per event and
      channel
- [ ] Add `GET /notifications/preferences` and `PATCH /notifications/preferences`
- [ ] Add the `notification_log` entity, purged by Phase 16
- [ ] Centralise MarkdownV2 escaping in one helper; Telegram rejects messages
      containing unescaped `_`, `*` and backticks
- [ ] Support Telegram topic/thread ids to route event types to different rooms
- [ ] Emit these events: user registered, user deleted, repeated failed logins,
      new device login, 2FA enabled or disabled, retention job anomaly

Implementation note: the channel interface is the whole extension story. A
third party adds a channel by providing one class; the core is not modified.

Expected outcome:

- Registration triggers a notification on every enabled channel.
- Disabling a channel is a config flag, and a failing channel never blocks the
  request.

Expected commit:

```text
feat: add multi-channel notifications
```

---

## Phase 19: Account Security Features

Status: Pending

Goal:

Close the account-lifecycle gaps that real deployments get asked about.

Tasks:

- [ ] Add an email verification gate, blocking sensitive actions until the
      address is verified
- [ ] Add a password policy in zod, with an optional `zxcvbn` strength score
- [ ] Check new passwords against a breach list using the k-anonymity API, or
      an offline list
- [ ] Keep the last N password hashes and reject reuse
- [ ] Add a permanent account lockout with an unlock flow and a notification.
      Phase 17a already blocks login temporarily; this is the version that needs
      an administrator or a verified email to clear
- [ ] Add an audit log entity: actor, action, before/after diff, ip, user
      agent, request id, append-only
- [ ] Record an audit entry on every privileged action, through an interceptor
      plus a TypeORM subscriber for writes that bypass a controller
- [ ] Add an `Idempotency-Key` header guard on mutating endpoints, so a client
      retry after a timeout cannot create a duplicate
- [ ] Add `@VersionColumn()` to the mutable entities for optimistic concurrency
- [ ] Add `user.requestDeletion()`: soft delete, queue a data export, hard
      delete at the end of the retention window, a right-to-erasure flow built
      on Phase 16
- [ ] Add a data export endpoint, CSV and JSON, streamed for large result sets

Expected outcome:

- Insecure passwords, unverified addresses and repeated attacks are all visible
  and handled.
- Every privileged action is attributable to a person and a request.

Expected commit:

```text
feat: add account security, audit log and idempotency
```

---

## Phase 20: Operational Hardening

Status: Pending

Goal:

Make the new features observable and operable, so a failure at 3am is a
dashboard, not an investigation.

Tasks:

- [ ] Extend `/health` with mail transport, queue connectivity and backlog
      depth, all reporting degraded rather than down
- [ ] Expose the last successful maintenance run in the health payload
- [ ] Add Prometheus metrics: `mail_sent_total`, `mail_failures_total`,
      `notification_sent_total`, `job_lag_seconds`,
      `retention_rows_deleted_total`
- [ ] Add OpenTelemetry traces spanning HTTP, database and job execution
- [ ] Propagate `X-Request-Id` into every log line, mail record and
      notification record
- [ ] Add Sentry error reporting with release tagging
- [ ] Add alert rules: failure rate above a threshold, a non-empty dead-letter
      list, a maintenance job that has not run in 26 hours
- [ ] Redact token, secret and OTP fields in the logger
- [ ] Add a runbook in `docs/`: provider outage, Redis loss, queue backlog, and
      tracing a missing email through `mail_logs`
- [ ] Add a Grafana dashboard for auth failure rate, job lag and mail delivery

Expected outcome:

- Each new subsystem is visible before it is asked about.
- The runbook answers the common failure questions without reading code.

Expected commit:

```text
feat: add observability and operations for the new subsystems
```

---

## Phase 21: Testing Depth and Documentation

Status: Pending

Goal:

Prove the new behaviour, especially the optional-dependency and cache paths,
which are the ones that fail quietly.

Tasks:

- [ ] Add unit tests for every new service and template
- [ ] Add an integration test that boots the app with an empty
      `optionalDependencies` and asserts every feature degrades cleanly
- [ ] Add a cache test that mutates a user and re-reads immediately, asserting
      invalidation happened rather than trusting the TTL
- [ ] Add a retention test with a dry run, asserting nothing is deleted
- [ ] Add `testcontainers` for real Postgres and Redis in e2e
- [ ] Run the e2e suite in CI against service containers, it currently only
      type checks
- [ ] Add a k6 or Artillery smoke test for login, register and refresh
- [ ] Add mutation testing on the auth and retention paths, where a silent
      logic error is expensive
- [ ] Write `src/modules/mail/README.md`, `src/modules/queue/README.md`,
      `src/modules/notification/README.md`, `src/modules/maintenance/README.md`
- [ ] Update `docs/production.md` and the root `README.md` with the new
      environment variables and the module list

Expected outcome:

- A regression in cache invalidation or optional loading fails CI.
- Every new module is documented next to its code, in the same commit.

Expected commit:

```text
test: cover optional dependencies, cache invalidation and retention
```

---

## Phase 22: Configurable Email Templates

Status: Pending

Goal:

Let an operator change a welcome email or a password reset email without a
deploy, by storing the template in the database and rendering it with a real
engine. Phase 14 ships plain functions, which is right for a boilerplate: the
templates in the repository are code, they are reviewed in a diff, and the app
has no template dependency at all. This phase trades both for editability.

Tasks:

- [ ] Add `handlebars` as a dependency, and say plainly in the README that the
      no-dependency property of Phase 14 is what is being given up
- [ ] Create the `email_templates` entity: name, locale, subject, text, html,
      version, `updatedBy`, timestamps
- [ ] Ship the six Phase 14 templates as `.hbs` files, and seed the table from
      them so a fresh clone has every template present
- [ ] Make the database row the override and the `.hbs` file the fallback, so an
      app with an empty table still sends every mail
- [ ] Render through `CacheService.wrap()` under a new `CACHE_NAMESPACE.Mail`
      key, so a hot template expiring under load does not stampede the table
- [ ] Invalidate the cache entry on every template write, so an edit takes
      effect on the next send rather than after a TTL
- [ ] Add `GET/PUT /admin/mail-templates/:name` behind a permission, writing an
      audit entry through the Phase 19 audit log
- [ ] Reject a stored template containing the triple-brace form, since raw
      interpolation of a user-controlled field is stored XSS in the mail client
- [ ] Keep the per-template data contract: the admin form lists the allowed
      fields, so an editor cannot add a variable no call site supplies
- [ ] Preview a stored template against sample data before saving it
- [ ] Purge template versions older than the Phase 16 retention window

Implementation note: a stored template is untrusted input even though only an
admin writes it. Handlebars escapes the double-brace form and not the
triple-brace one, so a template that opts out of escaping turns a first name
into script in a mail client. The narrow rule is that the triple-brace sequence
is rejected in anything read from the database, while a `.hbs` file in the
repository is trusted because it went through review.

Expected outcome:

- An operator edits a transactional email in the running app, with a preview,
  and the change reaches the next send.
- A template can still be reviewed in a diff, because the file remains the
  fallback and the seed.

Expected commit:

```text
feat: add database-managed email templates
```

---

## Follow-up Candidates

Not scheduled. Each needs a decision before it becomes a phase.

- File uploads to S3-compatible storage, with presigned URLs, content-type
  validation and a virus scan hook.
- Feature flags and remote config, Redis-backed, evaluated server-side.
- Completing the admin module: pagination, filtering, force logout, impersonation
  with an audit trail, and a role editor.
- API deprecation headers, `Sunset` and per-version throttles, on top of the
  existing `/api/v1` prefix.
- Multi-tenancy, an optional `tenantId` plus a global scope. Only worth it for a
  SaaS product, so it is deliberately last.
- Pagination on the admin and user listing routes, which still return everything
  they match.
- Restricting `GET /users/:id` to the record's owner or an admin. It is still
  readable by any authenticated user, which is recorded as an open decision in
  `src/modules/users/README.md`.

---

## Current Execution Rule

One phase at a time, in the order below.

Before starting a phase:

1. Review this plan.
2. Confirm the target phase.
3. Implement only the required files.
4. Run `npm run check` when applicable.
5. Commit the phase separately.

The order is not arbitrary. Mail without a queue blocks requests. Retention
without a queue either runs inside a request or does not run at all. The cache
work is independent but is the highest-risk change to existing behaviour, so it
lands after the harness in Phase 12 is solid.

---

## Progress Tracking

| Phase     | Name                                           | Status  |
| --------- | ---------------------------------------------- | ------- |
| Phase 0   | Project Architecture Skeleton                  | Done    |
| Phase 1   | Base Application Foundation                    | Done    |
| Phase 2   | Users Module                                   | Done    |
| Phase 3   | Auth Module - Basic JWT                        | Done    |
| Phase 4   | Authorization - RBAC and Manager Scope         | Done    |
| Phase 5   | Admin Module Foundation                        | Done    |
| Phase 6   | API Documentation                              | Done    |
| Phase 7   | Refresh Tokens                                 | Done    |
| Phase 8   | Device Authentication                          | Done    |
| Phase 9   | Two-Factor Authentication                      | Done    |
| Phase 10  | Cache and Performance                          | Done    |
| Phase 11  | Production Hardening                           | Done    |
| Phase 12  | Optional Integration Foundation                | Done    |
| Phase 13  | Configuration Expansion                        | Done    |
| Phase 14  | Outbound Email                                 | Done    |
| Phase 15  | Background Job Queue                           | Done    |
| Phase 16  | Data Retention and Cleanup                     | Done    |
| Phase 17a | Permission-based Authorization                 | Done    |
| Phase 17b | Authentication and Authorization through Cache | Pending |
| Phase 18  | Notifications                                  | Pending |
| Phase 19  | Account Security Features                      | Pending |
| Phase 20  | Operational Hardening                          | Pending |
| Phase 21  | Testing Depth and Documentation                | Pending |
| Phase 22  | Configurable Email Templates                   | Pending |
