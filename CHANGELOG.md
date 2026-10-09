# Changelog

Every notable change, newest first, in the order it happened. Entries are grouped
by the commit that made them, carry the task list from the phase that produced
them, and hold the implementation detail that used to live in
[PLAN.md](PLAN.md) before it moved next to the code.

This is a boilerplate, so there is no release history to version. It starts at
`0.0.1` and whatever you build on top of it is yours to version as you see fit.
What matters here is being able to read what a change did and why, without
reading the diff.

The current documentation, describing how the code behaves now, lives next to the
code itself. This file is the record of how it got that way.

---

## docs: document the authentication cache

Phase 17b. Intended commit: `docs: document the authentication cache`

**Tasks**

- [x] Replace the note saying authentication state is not cached, which Phase 17b
      made false
- [x] State the three keys, their TTLs, and the two rules that keep a stale entry
      from becoming an authorisation bug

**Notes**

- `src/core/cache/README.md` still carried the line from Phase 10 that
  `JwtStrategy` reads `isActive`, `role` and `isManager` on every request on
  purpose. It stopped being true the moment the claims moved into the cache, and a
  reader following it would conclude that a deactivation waits out a TTL.

---

## refactor: build the redis store through the keyv factory

Phase 17b. Intended commit: `refactor: build the redis store through the keyv factory`

**Tasks**

- [x] Stop building the redis client by hand
- [x] Close the store through Keyv's own `disconnect`

**Notes**

- The comment inherited from Phase 12 claimed `createKeyv` "only accepts a URL and
  hardcodes the socket options", so the store could not be configured. That is
  false for the installed version, whose first argument is `RedisClientOptions`.
  Verified by running both forms and reading one from the other.
- The hand-built client had a real bug: it was never closed, so `npm run seed`
  printed its last line and sat there with the event loop held open.

## feat: expose role permissions over the admin api

Phase 17b. Intended commit: `feat: expose role permissions over the admin api`

**Tasks**

- [x] `GET` and `PUT /admin/roles/:role/permissions`, behind `role:read` and
      `role:write`
- [x] Answer with what the role holds afterwards, not with what was requested

**Notes**

- The route exists so that changing a grant goes through the application, and
  therefore through the invalidation that follows a write. Before it, the only way
  to change a role's grants was SQL, which bypasses the cache and leaves the
  change waiting out the TTL.
- `role:write` is held by the super administrator alone. Handing it to `admin`
  would let one administrator grant themselves another administrator's.
- An unknown role is refused by a pipe rather than written: a role nobody holds is
  a role that can reach no guarded route and looks merely empty.
- This cannot catch an operator who still uses SQL. That window is documented in
  `SECURITY.md` and `docs/production.md` rather than closed, because nothing inside
  the application can see a write it did not make.

## fix: clear cached role grants from the permission seeder

Phase 17b. Intended commit: `fix: clear cached role grants from the permission seeder`

**Tasks**

- [x] Drop the cached grant set of every role the catalogue names
- [x] Derive the key list from `ROLE_PERMISSIONS` rather than listing roles
- [x] Fail soft, because a seed that cannot reach the cache has still seeded

**Notes**

- Without it a deploy that adds a permission keeps serving the old grant set until
  the entry expires, so the permission that was just deployed does not work. The
  direction is the safe one: the guard refuses rather than admits.
- Best effort on purpose. Failing the seed over a cache outage would turn an
  eviction problem into a failed deploy, and the operator is told instead.
- A no-op for `CACHE_BACKEND=memory`, and necessarily so: an in-process cache holds
  entries no other process can reach.

## feat: revoke a session's access token, and the one a rotation supersedes

Phase 17b. Intended commit: `feat: revoke a session's access token, and the one a rotation supersedes`

**Tasks**

- [x] Carry the session id in the access token, and refuse a revoked one
- [x] Record the session a rotation superseded, after the transaction commits
- [x] Return the revoked row's `jti` from the update rather than reading it back

**Notes**

- `DELETE /auth/sessions/:id` revoked the refresh token, so the session came back
  on the next refresh and the access token in the caller's hand kept working for
  the rest of its fifteen minutes. Nothing about the response changed; it was
  simply not taking effect until the token expired on its own.
- The session, not the access token, is the unit. Every access token from one
  refresh chain shares the id, so a revocation is one write; giving each token its
  own id would mean a revocation had to name every token that chain ever produced,
  and that set is not knowable from the database.
- Recorded **after** the commit, not inside it. Recorded before, a rollback leaves
  a client holding a live refresh token and no live access token at all. The first
  version had it inside, and the test that asserts the order is what noticed.
- The revocation key is written directly and never invalidated, because a revoked
  session has no column to re-read it from. It carries an exact lifetime, with the
  jitter every other entry gets switched off: an entry that expires early lets the
  tokens it revoked start working again.
- Rotation ending the old access token means a client that loses the response to a
  refresh is left with nothing, and its retry presents a rotated token, which is
  the reuse signal that drops every session on the account. A lost response and a
  leaked token are indistinguishable server-side, and the design already treated
  them as the same thing.

## feat: revoke an access token when its device signs out

Phase 17b. Intended commit: `feat: revoke an access token when its device signs out`

**Tasks**

- [x] A `sessionsVersion` on `user_devices`, incremented on sign-out
- [x] Carry the device and its version in the access token, and compare them
- [x] Revoke a device's tokens from `DELETE /auth/devices/:id` as well

**Notes**

- `users.sessionsVersion` is per account by construction: bumping it takes out
  every device at once. It cannot answer "is this session still allowed in",
  because a logout names one machine and the token named none, so the counter moved
  to where the scope already was.
- Setting `isActive` alone would have done nothing. The strategy never reads that
  column, so a revoked device with a row still in the table looks exactly like a
  live one.
- A device **absent** from the map is refused rather than skipped. Retention removes
  devices with no live refresh token, and treating absence as "nothing to check"
  would let a token minted before the deletion keep working for the rest of its
  lifetime.
- A token naming no device is not checked at all. That is every token minted before
  this claim existed, so reading it as revoked would sign out every signed-in user
  on deploy.

## perf: report cache loss as degraded

Phase 17b. Intended commit: `perf: report cache loss as degraded`

**Tasks**

- [x] Report an unreachable or mismatched cache as `degraded`, never `down`
- [x] Pin the terminus behaviour this relies on

**Notes**

- Everything downstream of redis fails open: rate limiting lets requests through,
  the lockout stops counting, the auth cache falls back to a query. The service
  keeps serving traffic throughout, more slowly.
- Terminus treats `down` as a failure and throws 503, so an orchestrator would pull
  every instance out of rotation over a redis problem and turn a cache outage into
  an outage of a system that was still answering requests. `degraded` lands in
  `info` and the request returns 200.
- The check still writes a value and reads it back. cache-manager turns a failing
  store into a miss, so a plain read cannot tell an unreachable cache from an empty
  one.

## perf: guard the sessions version against an uninvalidate write

Phase 17b. Intended commit: `perf: guard the sessions version against an uninvalidate write`

**Tasks**

- [x] Assert a revocation-critical column is only written where the cache is dropped
- [x] Assert the amount is an increment and never a fixed value

**Notes**

- This replaces the invalidation subscriber the plan asked for. A subscriber gets
  no dependency injection, because TypeORM builds it with `new target()`, and every
  write whose invalidation matters arrives from a query builder with no row id. It
  would have fired on all of them and been able to act on none.
- A convention asks everyone to remember. This fails the build when a third site
  appears without an invalidation, which is the outcome the subscriber was supposed
  to give. Verified by planting a bump in `DeviceService` and watching it fail.

## perf: serve authorization from cache

Phase 17b. Intended commit: `perf: serve authorization from cache`

**Tasks**

- [x] Cache the permission names under `role:<role>`, TTL 600s
- [x] Drop the entry when a role's grants are rewritten, after the commit

**Notes**

- Cached **per role**, not per user: one entry serves every holder, and invalidating
  is one delete. `CacheService` has no pattern delete on purpose, so a per-user key
  would have turned every role change into a scan of the user table.
- A role with nothing granted is cached like any other answer, because a plain user
  is the common case and an empty array is a value rather than a null. An absent
  role is not cached at all: `cacheKey` drops an empty part, so it would be filed
  under a bare `role` key.
- `forRole` resolved in the strategy, not the guard, so it is one read per request
  rather than one per guarded route.

## perf: serve authentication from cache

Phase 17b. Intended commit: `perf: serve authentication from cache`

**Tasks**

- [x] Cache the claims under `user:<id>`, TTL 60s, and read them in the strategy
- [x] Select six named columns, so the password hash is never read
- [x] Drop the entry after the write that changed it

**Notes**

- The projection omits the password hash on purpose. Caching the row the strategy
  reads would put every bcrypt hash in redis, which is offline cracking material in
  a store that is usually less protected than the database it duplicates.
- The cache delete is **after** the transaction, and that ordering is the whole
  point of `runThenInvalidateAuthCache`. A delete inside the transaction lets a
  request arriving before the commit refill the entry from the old snapshot, and
  that entry then outlives the token it wrongly admitted. Small window, silent
  failure.
- No try/catch here. cache-manager already turns a failing store into a miss, and a
  local catch would also swallow a genuine failure from the loader.
- No email lookup and no per-user permission key; both are explained in the plan.

## feat: block login temporarily after repeated failures

Phase 17a. Intended commit: `feat: block login temporarily after repeated failures`

**Tasks**

- [x] Count failures per address in redis, so the count holds across replicas
- [x] Block for a minute at five failures, a minute more per further failure,
      capped at fifteen
- [x] Answer 429 with `Retry-After` and nothing else about the wait
- [x] Notify the owner once per lockout, never for an unregistered address
- [x] Fail open when redis is unreachable

- The numbers are constants rather than environment variables, matching how the
  mail buckets were done. That is a departure from the rest of the
  configuration, and it is a decision worth revisiting if a deployment needs to
  tune the lockout without a release.
- The body of the 429 deliberately omits the remaining time and the header carries
  it, because a body naming the time left is a progress bar for somebody guessing
  a password.
- Failures are counted for addresses that do not exist. Counting only real
  accounts would make the status code answer which addresses exist, which is the
  question the enumeration floor exists to keep closed. The cost is that anybody
  can lock an address out by guessing it wrong.
- Redis keys carry a digest of the address rather than the address, so an
  operator with read access does not acquire a mailing list.

## docs: mark phase 17a permission authorization as done

Phase 17a. Intended commit: `docs: mark phase 17a permission authorization as done`

**Tasks**

- [x] Mark the phase done and tick its tasks in the plan
- [x] Record what the phase found rather than built

- The two findings are the reason this entry is longer than a status flip. The
  per-address rate limits had never been enforced, and `account-locked` had been
  sitting in the template registry without a caller since Phase 14.

## fix: apply the per-address rate limits that were never enforced

Phase 17a. Intended commit: `fix: apply the per-address rate limits that were never enforced`

**Tasks**

- [x] Declare every named bucket in the throttler module options
- [x] Gate each one behind a `@RateLimit` marker so it applies to opted-in routes
- [x] Key both email buckets on the submitted address

- `ThrottlerGuard` builds its list from the module options and nothing else, then
  loops over that whole list on every request. A bucket named only in
  `@Throttle()` metadata is never reached, so the three-per-hour per-address mail
  limit configured in Phase 14 had been enforced by nothing. It was written, tested
  and documented.
- The polarity is opt-in because declaring the buckets globally otherwise puts the
  mail limit on every endpoint in the application.
- The route-level limit and the module-level limit were initially declared in two
  places, and a test caught it: `@Throttle` overrides the module value, so two
  sources of the same number drift. The numbers now live in one place.

## feat: share the rate limit across replicas

Phase 17a. Intended commit: `feat: share the rate limit across replicas`

**Tasks**

- [x] Add a throttler storage over the existing redis client
- [x] Count and decide in one atomic step
- [x] Block for the rest of the window once exceeded
- [x] Fail open when redis is unreachable

- The decision is a Lua script rather than a read and a write, because the race
  is the bug: two requests read the same count, both write the next value, both
  are allowed. That is the burst an attacker sends.
- The counter resets when a block is set. Without that the counter is still above
  the limit when the block lifts, the next request re-blocks, and a temporary
  lockout becomes permanent. Verified against a real redis rather than reasoned
  about.
- A request that arrives while blocked does not extend the block, or a client
  polling in a loop is never released.

## feat: kill every access token on logout everywhere

Phase 17a. Intended commit: `feat: kill every access token on logout everywhere`

**Tasks**

- [x] Add a `sessionsVersion` column, incremented on logout everywhere and on a
      password reset
- [x] Carry it in the access token and compare it in the strategy
- [x] Accept a token with no claim only while the user is still at zero

- A permanent lockout would have been simpler and wrong: anyone can sign out a
  victim's account, and the owner is the person least able to fix it.
- A token issued before the column existed is accepted only while the user's
  version is zero, meaning nothing has asked for their sessions to die. Strict
  equality would sign out everyone on deploy, to protect a fifteen minute token
  that expires on its own.

## feat: list and revoke sessions

Phase 17a. Intended commit: `feat: list and revoke sessions`

**Tasks**

- [x] `GET /auth/sessions`, listing live refresh sessions with their device
- [x] `DELETE /auth/sessions/:id`, revoking one session and not the others

- A session is one live refresh token, not one device. Rotation leaves a chain of
  revoked rows behind exactly one live row, and one device can hold several.
- Revocation is scoped to the caller, and an id that is not theirs answers exactly
  as one that does not exist, because "not yours" confirms the id is real.
- There is no "is this my current session" flag. The access token carries neither
  a device nor a token id and the refresh token travels in the body, so the server
  cannot tell. The client already holds the token and can match the id itself.

## feat: enforce permissions in the guard

Phase 17a. Intended commit: `feat: enforce permissions in the guard`

**Tasks**

- [x] Rewrite the guard to check the caller's set, denying by default
- [x] Apply `@Permissions()` to seven routes so the decorator has real callers

- Deny by default means an ordinary user holds nothing, so a route that names a
  permission refuses rather than admits anybody who has not been granted it. An
  unseeded permission locks a route instead of unlocking it.
- The guard throws a 403 naming the missing permission instead of returning
  false, which would be a bare 403 that tells an operator nothing about what to
  grant.
- The three permissions that cannot be undone from the admin screen sit behind the
  super administrator role.

## feat: add the permission model

Phase 17a. Intended commit: `feat: add the permission model`

**Tasks**

- [x] Add `Permission` and `RolePermission` with a unique pair
- [x] Seed the permission set each role starts with
- [x] Declare the catalogue and the grants together

- The plan assumed a permission system existed. It did not: there was no table,
  no entity, the decorator had no caller, and the guard returned true for every
  route.
- The unique index on the pair is what makes the seed idempotent. The first
  version reported every grant as new on every run, because a driver reports the
  rows it attempted rather than the ones the database kept.

## docs: split phase 17 into a permission phase and a cache phase

Intended commit: `docs: split phase 17 into a permission phase and a cache phase`

**Tasks**

- [x] Split the phase in two, releasable separately
- [x] Record the tasks that describe work already done or never needed

- The permission work is a feature and the cache work is a performance change.
  Bundled into one phase they could not be released independently.
- `wrapOrLoad()` was dropped: `CacheService.wrap()` already coalesces concurrent
  callers and already stores a nullish result for the short TTL.
- `token:revoked:<jti>` was dropped: there is no per-access-token revocation to
  cache. Refresh tokens carry `revokedAt` and access tokens die through the
  version claim.
- The health task was not an addition but a change: the indicator already existed
  and reported `down`.

## fix: cascade user devices and two-factor secrets on user delete

Phase 16. Intended commit: `fix: cascade user devices and two-factor secrets on user delete`

**Tasks**

- [x] Cascade `user_devices` and add the missing constraint on `two_factor_secrets`

- `two_factor_secrets` declared the column without a relation, so TypeORM generated
  no constraint at all and a hard-deleted user left the secret behind forever.
- `user_devices` was `NO ACTION`, so deleting a user who still had a device raised
  a foreign key violation, at three in the morning, from a job nobody was watching.

## feat: define the retention policy table

Phase 16. Intended commit: `feat: define the retention policy table`

**Tasks**

- [x] One entry per table, each with its own predicate
- [x] Keep a deferred list so the gap is reviewable

- The policy is data rather than a switch statement, so adding a table is adding
  an entry and each predicate is testable without a database.
- Four tables named in the plan have no table yet. They are listed as deferred
  rather than left out, because a rule naming a missing table would fail on every
  run.

## feat: add batched retention deletes

Phase 16. Intended commit: `feat: add batched retention deletes`

**Tasks**

- [x] Delete in batches, one transaction each, with a pause between
- [x] Add a dry run that counts and deletes nothing
- [x] Stop on the run timeout rather than finishing the batch in progress

- A query runner returns the tuple `[entities, affected]` for a statement with
  `RETURNING`, not the deleted rows. Reading the array length counts two for every
  delete, which either loops until the timeout or stops after the first batch,
  silently, depending on the batch size.
- A failed target is recorded and skipped rather than ending the run. One renamed
  column should cost a skipped table, not a week of uncollected data.

## feat: add the maintenance run log

Phase 16. Intended commit: `feat: add the maintenance run log`

**Tasks**

- [x] Add an append-only run log with no index
- [x] Record the per-target detail so the history can be read without a chart

- A run is about 728 bytes stored, so a year of nightly runs is roughly 260 KB.
  An index would be the only index on the table and would cost more than it saves.
- The migration also tried to alter a column from the previous phase, because a
  default declared as a callback does not compare equal to what the driver reads
  back. Every later migration would have carried the same two lines.

## feat: add the maintenance job processor

Phase 16. Intended commit: `feat: add the maintenance job processor`

**Tasks**

- [x] Run the policy as a queue job and record the run
- [x] Share one execution path between the schedule and the admin route

- The processor sits below the queue in the module graph and the scheduler above
  it, which is why the scheduled entry is a separate module rather than a member
  of the same one. The alternative was `forwardRef`, which hides a loop rather than
  removing it.
- A run that finished is a success even when individual targets failed: a renamed
  column answers a retry identically five seconds later. A timeout is the opposite
  and stays retryable, because tables were left unclean.

## feat: schedule the retention job

Phase 16. Intended commit: `feat: schedule the retention job`

**Tasks**

- [x] Schedule the nightly run through the job queue
- [x] Default `RETENTION_ENABLED` to true

- Registered with `SchedulerRegistry` and a script built at bootstrap, because the
  decorator needs its expression as a literal at the moment the class is defined.
- A malformed schedule is logged and the job is not scheduled, rather than
  throwing out of bootstrap over a typo in an environment variable.
- The schedule does not catch up a missed run. Restarting is fine because the
  schedule is re-registered on every boot, but a process that is not running at
  that minute loses the night, and nothing logs it.

## feat: expose retention runs to an admin

Phase 16. Intended commit: `feat: expose retention runs to an admin`

**Tasks**

- [x] A dry run that answers synchronously, and a real run that is queued
- [x] Read the history
- [x] Require a permission for the two routes that change data

- The dry run is synchronous because counting is fast enough to answer inside a
  request and an operator rehearsing against production data wants the numbers
  now. A real run is queued because batching can take minutes.
- The two write routes need `maintenance:run` while the read routes stay at the
  manager level, so reading the history does not carry the ability to delete
  every user in the database.

## docs: licence, contributor and security documentation

Intended commit: `docs: add licence, contributing guide, security policy and roadmap`

**Tasks**

- [x] Add a licence
- [x] Add a contributing guide
- [x] Add a security policy
- [x] Add a roadmap with enhancement plans
- [x] Add this changelog, written per commit
- [x] Rewrite the README to introduce the project

- `LICENSE` is MIT. The boilerplate is meant to be forked and used, and a licence
  that discourages that makes the whole exercise pointless.
- `SECURITY.md` records what is in scope and where to report privately, and lists
  the known limitations that matter for a real deployment: per process rate
  limits, the unguarded `GET /users/:id`, the two-factor key that has a default,
  and the compose stack that uses development secrets.
- `ROADMAP.md` separates the three open decisions from the enhancement plans, so
  an undecided question is not read as a feature that already exists. Each plan
  carries what it would cost, and the ones that are cheap to get wrong, such as
  caching authorisation claims or deleting a large table in one statement, say so
  at the point where someone would otherwise just do it.
- The README is rewritten to introduce the project rather than to describe the
  Nest starter it replaced, and it links to the folder readmes so an explanation
  is where you are already looking.

## test: build the platform app per branch so the types resolve

**Tasks**

- [x] Make the cross platform middleware spec type check

**Files**

```text
src/common/middlewares/request-id.middleware.spec.ts
```

- The cross platform middleware test built its application with
  `{ adapter: useFastify ? new FastifyAdapter() : undefined }`, which is a union
  the two `NestFactory.create` overloads both reject, so the spec file did not
  type check even though the tests passed.
- Each branch now calls `create` with the shape that branch actually uses. A test
  that runs but does not compile is a broken test: it stops anyone running
  `npm run typecheck`, which is one of the four checks CI performs.

## chore: enforce commit messages and staged formatting with husky

**Tasks**

- [x] Add husky
- [x] Add commitlint
- [x] Add lint-staged
- [x] Add a commit convention check
- [x] Add a staged formatting check
- [x] Add a `check` script running the same steps as CI
- [x] Record `license`, `author`, `repository`, `engines` and `packageManager`
- [x] Add a description and keywords for the package

**Files**

```text
.husky/commit-msg
.husky/pre-commit
commitlint.config.mjs
package.json
package-lock.json
.gitignore
```

- husky writes to `.husky/_`, which is gitignored. `npm install` restores the
  hooks through the `prepare` script, so a fresh clone has them without a manual
  step.
- commitlint follows Conventional Commits, with the subject pinned to lower case
  so the history keeps the style it already has instead of each message choosing
  its own. A malformed message fails the commit rather than waiting for CI.
- lint-staged runs Prettier and `oxlint --fix` on staged files only, so a commit
  never reformats work that is not part of it.
- `npm run check` runs the four steps CI runs, in the same order, so the whole
  gate is available locally in one command.
- `package.json` was `UNLICENSED` with an empty description and no repository, so
  a published package of this template would have said nothing about where it
  came from or what it was.

## docs: move implementation notes from the plan into folder readmes

**Tasks**

- [x] Remove implementation notes from `PLAN.md`
- [x] Add a README to `src/configs`
- [x] Add a README to `src/database`
- [x] Add a README to `src/common`
- [x] Add a README to `src/core`
- [x] Add a README to `src/core/health`
- [x] Add a README to `src/core/logger`
- [x] Add a README to `src/core/swagger`
- [x] Add a README to `src/modules`
- [x] Add a README to `src/modules/auth`
- [x] Add a README to `src/modules/users`
- [x] Add a README to `src/modules/admin`
- [x] Point `PLAN.md` at the readmes

- The implementation notes were removed from `PLAN.md`, which now holds only the
  phases, their status, the progress table and the follow-up candidates.
- The previous layer readmes listed files that do not exist: `redis.config.ts`,
  `RequestIdInterceptor`, `TimeoutInterceptor`, and the `exceptions` and
  `serializers` directories. All of that was aspirational and misleading, and it
  is now either real or gone.
- Two previously invisible decisions are recorded rather than implied: rate limits
  are counted per replica, and `GET /users/:id` is readable by any authenticated
  user.

## chore: add production hardening foundation

**Tasks**

- [x] Add rate limiting
- [x] Add security headers
- [x] Add CORS config
- [x] Add request id
- [x] Add structured logging
- [x] Add health check
- [x] Add graceful shutdown
- [x] Add environment validation
- [x] Add seed command
- [x] Add migration command
- [x] Add CI workflow
- [x] Add Dockerfile
- [x] Add docker-compose for local development

**Files**

```text
src/configs/security.config.ts
src/configs/cors.config.ts
src/configs/throttler.config.ts
src/configs/env.validation.ts
src/common/middlewares/request-id.middleware.ts
src/common/middlewares/catch-all-route.util.ts
src/common/utils/request-id.util.ts
src/core/logger/app.logger.ts
src/core/health/health.module.ts
src/core/health/cache.health.ts
src/core/health/shutdown.service.ts
src/database/data-source.ts
src/database/seed.ts
src/database/seeds/
src/database/migrations/
docs/production.md
Dockerfile
docker-compose.yml
.github/workflows/ci.yml
```

- Rate limiting is a global `ThrottlerGuard`, so a new endpoint is limited from
  the moment it exists. The credential routes override it with `@Throttle`,
  because 100 per minute is no defence at all for a route that accepts a
  password: login is 5 per minute, the TOTP routes 5 per 5 minutes, since a six
  digit code is 1 in a million. Counters are in process memory, so with several
  replicas the limit is per replica.
- CORS defaults to same-origin only and `credentials` to false, since this API
  authenticates with a bearer token rather than a cookie. Validation rejects
  `CORS_CREDENTIALS=true` together with a wildcard, because browsers refuse that
  pairing anyway and a config that only appears to work is worse than one that
  fails.
- A request id is reused from the client only when it is 8 to 64 characters of a
  restricted charset. The id lives in an `AsyncLocalStorage`, so logs from deep
  inside a service correlate without the call site knowing about requests.
  Measured with a raw socket, Node's HTTP parser rejects a newline in a header
  with a 400 before any handler runs, so the charset rule is defence in depth
  rather than the thing standing between a caller and a forged log line.
- The middleware is platform independent. `header()` is the one spelling both
  Express and Fastify have, and `catchAllRoute` picks the wildcard per adapter,
  because `path-to-regexp` v8 and `find-my-way` spell a catch-all differently and
  neither accepts the other's. Tested on both adapters with a real HTTP server.
- Logging is one JSON object per line in production, with the request id
  included when there is one. Development keeps Nest's own logger, which is
  coloured and prints how long each module took to initialise, and that number is
  lost the moment output becomes JSON.
- Health checks are split into liveness and readiness. Liveness touches nothing
  external, because a failing liveness probe makes an orchestrator restart every
  healthy instance at the exact moment a dependency is down.
- The cache health check writes a random value and reads it back. A plain read
  would report healthy on a dead cache, which is the same trap that made
  `CacheService.isHealthy()` impossible.
- Environment validation reports every problem at once. It is strict in
  production, where a secret that still holds the `.env.example` value counts as
  unset, and lenient in development so a placeholder does not block local work.
  The schema is `zod`; its own messages are kept, and messages are written only
  for the `refine` checks where zod would otherwise say nothing useful.
- `synchronize` is off and schema changes go through reviewed migrations.
  Entities are listed explicitly in the standalone data source, since
  `autoLoadEntities` only works inside the Nest container and a migration that
  missed an entity would silently generate an incomplete schema.
- The seed creates one admin and is idempotent. With no `ADMIN_PASSWORD` it
  generates a 24 character password and prints it once, and checks for an
  existing admin before generating anything, so a second run stays silent rather
  than printing a password that will not work.
- The Docker image is a two stage build running as the `node` user, and its
  healthcheck uses the liveness endpoint so a database problem cannot get the
  container restarted.

## feat: add redis cache foundation

**Tasks**

- [x] Add Redis config
- [x] Add cache module
- [x] Add cache service abstraction
- [x] Add cache key constants
- [x] Add cache decorators/helpers if needed

**Files**

```text
src/configs/cache.config.ts
src/core/cache/cache.module.ts
src/core/cache/cache.service.ts
src/core/cache/cache-keys.ts
```

- Uses `@nestjs/cache-manager` with Keyv, and `@keyv/redis` for Redis and
  Valkey. Both talk the same protocol, so only `backend` differs between them.
  `CACHE_URL` is the whole connection configuration, including credentials, TLS
  and database, which is what the Redis client takes anyway.
- Exactly one store. `CACHE_BACKEND=memory` is an explicit choice for local
  development, never a silent fallback, so a configured but unreachable cache
  fails the boot instead of quietly serving per-instance data. The two store
  layout that `@nestjs/cache-manager` documents was rejected after measurement:
  memory first means the shared store is written but never read, and Redis first
  with a memory fallback resurrects values that were just deleted, because the
  delete only reached the shared store.
- An unreachable cache fails the boot, through a `store.get('__startup__')` probe
  with `throwOnErrors` on, since a Keyv store connects lazily and the app would
  otherwise start and fail on the first request. Errors are switched off after
  the probe so a later outage is a miss rather than a 500.
- `CacheService.wrap()` is the miss handler and the failover back to the
  database. It delegates to cache-manager, which already supplies request
  coalescing and stale while revalidate, so neither is reimplemented here.
  Measured on Valkey: 300 concurrent requests on one hot key cause 1 loader call;
  a read inside the refresh threshold returns in 80ms while the loader takes
  200ms, and the refreshed value appears afterwards.
- Nullish results are cached for `CACHE_EMPTY_TTL` rather than the full TTL, so
  repeated lookups of something missing stop hammering the loader while a record
  created afterwards still appears quickly. This does not help a client
  enumerating many different missing ids, since each is a separate key.
- Expirations carry a 10% jitter, so a bulk write does not put every entry on
  the same deadline and expire them in one burst.
- `disableOfflineQueue` is set on the client, so a command issued while the
  socket is reconnecting reports a miss instead of waiting for the outage to end.
  It does not remove the cost of a dead cache: the store re-attempts the
  connection on every operation, and each attempt waits out
  `CACHE_CONNECT_TIMEOUT`. Measured against an unreachable cache with the default
  2000ms, one request costs 4003ms, because the read misses and the write back
  fails. Concurrent requests for the same key still share a single loader run, so
  the outage costs latency rather than correctness.
- Invalidation is by explicit key only. There is no `deleteByPattern`, because
  scanning a keyspace is unbounded on a shared server and a broad pattern fails
  silently.
- Authentication state is not cached, so a role change or a deactivation takes
  effect on the next request instead of after a TTL.

## feat: add two-factor authentication foundation

**Tasks**

- [x] Add 2FA secret storage
- [x] Add 2FA setup endpoint
- [x] Add 2FA verify endpoint
- [x] Add 2FA login flow
- [x] Add recovery code support if needed

**Files**

```text
src/modules/auth/entities/two-factor-secret.entity.ts
src/modules/auth/two-factor.service.ts
src/modules/auth/dto/two-factor-*.dto.ts
src/common/utils/encryption.util.ts
src/common/utils/recovery-code.util.ts
src/configs/two-factor.config.ts
```

- TOTP via `otpauth`, QR codes via `qrcode`.
- The shared secret is never stored in the clear. It is encrypted with
  AES-256-GCM using `TWO_FACTOR_ENCRYPTION_KEY`, and the auth tag is verified on
  read so tampered rows fail loudly. Rotating the key invalidates every stored
  secret.
- `POST /auth/2fa/setup` issues a secret but does not activate 2FA.
  `POST /auth/2fa/verify` confirms it with a code and only then enables 2FA and
  returns the recovery codes, which are shown once.
- Recovery codes are Crockford style base32, stored as salted hashes and removed
  from the list as they are spent, so the array doubles as the set still usable.
- `POST /auth/login` returns HTTP 200 with a short lived challenge token instead
  of tokens when 2FA is on. `POST /auth/2fa/login` exchanges the challenge plus
  a TOTP code or a recovery code for the token pair.
- TOTP steps are single use. The last accepted counter is persisted, so replaying
  a code inside its own 30 second window is rejected.
- Five invalid attempts locks verification for 15 minutes.
- Setting `TWO_FACTOR_ENABLED=false` turns the feature off globally, and login
  falls back to the single factor flow.

## feat: add device authentication foundation

**Tasks**

- [x] Add user device entity
- [x] Store device info during login
- [x] List devices
- [x] Revoke device
- [x] Attach refresh tokens to devices

**Files**

```text
src/modules/auth/entities/user-device.entity.ts
src/modules/auth/device.service.ts
src/modules/auth/dto/user-device.dto.ts
src/modules/auth/types/device-metadata.interface.ts
```

- Devices are fingerprinted by user agent, so repeated logins from the same
  browser or app reuse a single `user_devices` row instead of creating
  duplicates. Logging in again from a revoked device reactivates it instead of
  failing.
- Each `refresh_tokens` row carries a `deviceId`. Rotation keeps the token on its
  original device, so a session can never hop between devices while refreshing.
- `DELETE /auth/devices/:id` deactivates the device and revokes every refresh
  token attached to it (`device_revoked`).
- `logout-all` revokes all refresh tokens and deactivates all devices.
- The friendly device name is derived from the `user-agent` header by the
  `@DeviceName()` decorator, so clients never have to send anything. An explicit
  `x-device-name` header overrides it. Both sources are untrusted, so the
  decorator trims the value, collapses whitespace and caps it at the column
  width.
- `parseUserAgent()` in `common/utils/user-agent.util.ts` is a dependency free
  best effort parser. Swap it for `ua-parser-js` if exhaustive coverage matters
  more than staying dependency free.

## feat: add refresh token authentication

**Tasks**

- [x] Add refresh token entity
- [x] Add refresh token DTO
- [x] Add refresh token rotation
- [x] Add logout
- [x] Add logout all devices
- [x] Store token metadata
- [x] Revoke old refresh tokens

**Files**

```text
src/modules/auth/entities/refresh-token.entity.ts
src/modules/auth/enums/refresh-token-revoked-reason.enum.ts
src/modules/auth/refresh-token.service.ts
```

- Every login, register and refresh call stores one `refresh_tokens` row.
- Rotation happens inside a database transaction with a pessimistic row lock, so
  concurrent refreshes of the same token produce exactly one winner.
- The rotated-out token keeps a `replacedById` pointer, which forms the rotation
  chain.
- Replaying a token that was revoked by rotation is treated as theft: all
  sessions of that user are revoked. Tokens revoked by an explicit logout are not
  a compromise signal and do not trigger the sweep.

## feat: integrate Swagger for API documentation

**Tasks**

- [x] Add Swagger config
- [x] Add Swagger setup in `core/swagger`
- [x] Add auth bearer documentation
- [x] Add tags for Auth, Users, Admin
- [x] Expose docs route

- `GET /docs`, with bearer authentication documented, and tags for Auth, Users
  and Admin.
- Each endpoint declares a response DTO, so the schema is declared rather than
  inferred. `POST /auth/login` returns either tokens or a two-factor challenge,
  which is spelled out with `oneOf` in `@ApiExtraModels`.
- Content-Security-Policy is off by default, because the Swagger UI needs inline
  script and style and a strict policy blocks it.

## feat: add admin health check and enhance dashboard functionality

**Tasks**

- [x] Create `admin.module.ts`
- [x] Create `admin.controller.ts`
- [x] Create `admin.service.ts`
- [x] Prefix admin routes with `/admin`
- [x] Apply manager-only access
- [x] Add basic admin health/dashboard route

- `GET /admin/health` and `GET /admin/dashboard`, both behind `@ManagerOnly()`
  on the controller so a new route there is protected by default.

## feat: implement role-based access control (RBAC) and manager scope handling

**Tasks**

- [x] Add metadata constants
- [x] Add `@Roles()` decorator
- [x] Add `RolesGuard`
- [x] Add `@ManagerOnly()` decorator
- [x] Add `ManagerGuard`
- [x] Protect manager/admin routes
- [x] Ensure only users with `isManager = true` can access `/admin` routes
- [x] Prepare `@Permissions()` decorator placeholder for future permission system

- `@Roles()` with a global `RolesGuard`, `@ManagerOnly()` with a `ManagerGuard`,
  and `@Permissions()` prepared for a finer permission system.
- The guards read the request context rather than injecting a feature service, so
  an authorisation failure reads the same as any other failure.

## feat: implement authentication module with JWT support

**Tasks**

- [x] Create `auth.module.ts`
- [x] Create `auth.controller.ts`
- [x] Create `auth.service.ts`
- [x] Add login DTO
- [x] Add register DTO
- [x] Add password hashing utility/service
- [x] Add JWT payload interface
- [x] Add JWT strategy
- [x] Add JWT auth guard
- [x] Add `@Public()` decorator
- [x] Add `@CurrentUser()` decorator
- [x] Add `/auth/register`
- [x] Add `/auth/login`
- [x] Add `/auth/me`

- Access token signing, scrypt password hashing with a per-row salt, and the
  `JwtStrategy` behind a global `JwtAuthGuard` with `@Public()` as the opt out.
- `UserResponseDto` has no property for the password, so a response cannot leak
  it even by accident.

## feat: implement user management module foundation

**Tasks**

- [x] Create `users.module.ts`
- [x] Create `users.controller.ts`
- [x] Create `users.service.ts`
- [x] Create `user.entity.ts`
- [x] Create create/update user DTOs
- [x] Add basic user response DTO
- [x] Add `Role` enum
- [x] Add `isActive`
- [x] Add `isManager`
- [x] Add timestamps
- [x] Add soft delete column if needed
- [x] Add methods to find user by id/email
- [x] Add basic user profile route

- `User` entity with a uuid from the database, a unique lower cased email,
  `isActive` and `isManager` kept separate, and a soft delete column.
- Create, read, update and soft delete, with admin only routes guarded by
  `@Roles(Admin, SuperAdmin)`.

## feat: enhance app configuration and introduce global utilities

**Tasks**

- [x] Define app config
- [x] Define JWT config placeholder
- [x] Organize existing database config
- [x] Add global validation pipe
- [x] Add global exception filter
- [x] Add global response transform interceptor
- [x] Add common metadata constants
- [x] Add base response DTO/interface
- [x] Add request context interface

- Namespaced configuration through `registerAs`, and the global validation pipe,
  exception filters and response transform interceptor.

## chore: initialize project structure with placeholders and documentation

**Tasks**

- [x] Create `src/configs`
- [x] Create `src/database`
- [x] Create `src/common`
- [x] Create `src/core`
- [x] Create `src/modules`
- [x] Add README for each main layer
- [x] Add root `PLAN.md`
- [x] Commit architecture skeleton

- The layer structure, and the rule that `common` may not depend on business
  modules.

## Add initial database and Observe configuration setup

- `DATABASE_URL` based connection, and the optional observability integration.

## Initialize NestJS boilerplate with basic setup

- Nest 12 on Express 5, ESM with NodeNext, Prettier, oxlint and vitest.
