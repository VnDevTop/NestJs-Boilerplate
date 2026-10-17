<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>
<p align="center">
  <a href="https://github.com/VnDevTop/NestJs-Boilerplate/actions/workflows/ci.yml"><img src="https://github.com/VnDevTop/NestJs-Boilerplate/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/VnDevTop/NestJs-Boilerplate"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="https://github.com/VnDevTop/NestJs-Boilerplate"><img src="https://img.shields.io/badge/node-%3E%3D22-5FA04E" alt="Node 22+" /></a>
  <a href="https://github.com/VnDevTop/NestJs-Boilerplate"><img src="https://img.shields.io/badge/typescript-5.7-3178C6" alt="TypeScript" /></a>
  <a href="https://github.com/VnDevTop/NestJs-Boilerplate"><img src="https://img.shields.io/badge/tests-1962%20unit%20%2B%2037%20e2e-5FA04E" alt="Tests" /></a>
</p>

<!--
  One live badge, not three per-job ones, and the reason is worth recording
  because the obvious version is wrong twice over:

  - GitHub's `badge.svg?job=<name>` ignores the parameter — every job returns
    the same SVG for the workflow, so three badges would be three copies of one
    answer. Verified by fetching two and diffing them.
  - A shields.io label pinned per job would be a static image that never
    changes colour, which is the original sin: it reads "passing" on a red
    build, and a status badge is read precisely when somebody is deciding
    whether to trust the repository.

  GitHub renders one status per workflow, so a workflow-wide badge is the most
  truthful thing available without generating per-job images in a job.
-->

# NestJS Boilerplate

A production-ready NestJS template for APIs that need authentication done
properly. The session handling, the authorisation and the deployment defaults are
already built and explained, so a new project starts from working code instead of
a scaffold.

Deliberately not a framework: there is no string of configuration objects, no
opinion on your domain, and no folder you have to fight. What is here is the
part that every real API needs and that is tedious to get right, and nothing
else.

## What is inside

**Sessions that behave correctly under attack**

- JWT access token with a rotating refresh token pair.
- Rotation inside a transaction with a row lock, so concurrent refreshes produce
  exactly one winner rather than two sessions.
- Replaying a token that was rotated out is treated as theft and revokes every
  session of that user. Logging out is not a compromise signal and does not.
- Devices fingerprinted by user agent, so logging in twice from one browser does
  not create two device rows, and revoking a device revokes its tokens.
- Optional TOTP two-factor, secret encrypted at rest, single use steps, and
  recovery codes shown once.
- `GET /auth/sessions` and `DELETE /auth/sessions/:id`, where a session is one
  live refresh token rather than one device, because one device can hold several.
  Revoking one also stops the access token already minted from it.
- **Four levels of revocation**, each scoped to something smaller than the last:
  the account, the device, the session, and the user row. Signing out of one
  browser leaves the phone signed in, and each is a counter compared on every
  request rather than a lookup.

**Authorisation you can reason about**

- `@Roles()`, `@ManagerOnly()` and a real `@Permissions()`, backed by a
  `permissions` table and a `role_permissions` join.
- Deny by default: an ordinary user holds no permissions, so a route that names
  one refuses rather than admits anybody who has not been granted it.
- Guards read the request context instead of loading services, so an
  authorisation failure reads the same as any other failure.
- The admin scope is guarded at the controller, which makes a new route there
  protected by default.

**Platform decisions already made**

- Configuration is namespaced and typed, and the whole environment is validated
  before anything connects. A missing secret is one clear error at boot, not a
  failure twenty minutes later.
- Redis or Valkey cache with request coalescing and stale while revalidate, so a
  hot key expiring under load does not stampede the database.
- Rate limiting counted in Redis rather than per process, so the configured limit
  is the real limit behind any number of replicas.
- Two limits on the credential routes, one per client address and one per
  submitted address, because neither alone stops both an attacker rotating hosts
  and an attacker guessing one account.
- Two account lockouts. A temporary Redis block after five failed sign-ins — a
  minute, then a minute more per failure, capped at fifteen — and a permanent one
  after twenty that only an operator or the owner of a confirmed address can clear.
  Only confirmed addresses can be locked permanently, because an unverified account
  could never receive the link that unlocks it.
- A password policy configured entirely by environment, an optional `zxcvbn` score,
  a breach check that sends only five characters of a SHA-1 to a k-anonymity API,
  and the last N hashes rejecting reuse.
- An append-only audit trail of every privileged action: actor, target, before/after
  diff, ip, user agent and request id, with a redactor that no credential passes.
- An `Idempotency-Key` header on mutating routes, so a client retrying after a
  timeout gets the original answer rather than a second account.
- Optimistic concurrency on the rows a request reads before it writes, so two
  administrators editing one profile produce a 409 instead of a silent lost update.
- Erasure with a thirty day grace window, and a streamed export of everything held
  about an account that selects no credential at all.
- Nightly data retention, batching deletes so cleanup costs latency rather than a
  long lock, with a dry run to rehearse against production data first.
- Request id on every response, and JSON logs in production that carry it.
- Liveness and readiness probes kept separate, so a database problem does not make
  an orchestrator restart every healthy instance.
- Migrations with `synchronize` off, an idempotent seed, graceful shutdown, a
  two stage Docker image and a local docker-compose stack.
- Prometheus metrics, OpenTelemetry spans and Sentry error reporting, each
  optional and each off by default. See [the optional integrations
  guide](docs/optional-integrations.md).
- Alert rules in [`ops/prometheus/alerts.yml`](ops/prometheus/alerts.yml), checked
  against the constants they are generated from so the two cannot drift, and a
  [runbook](docs/runbook.md) for each one.

**Transactional mail, off the request path**

- A welcome email, an address verification, a password reset, a password change,
  a new-device sign-in and both kinds of lockout, as nine templates that take
  exactly the fields they render. No template receives a user entity.
- A pluggable transport — memory, SMTP, SES, SendGrid — and every provider package
  is optional. A deployment with none installed still boots and still logs which
  transport actually ran, rather than reporting success for mail it dropped.
- Mail is queued, deduplicated on delivery, and retried on timeouts and 5xx but
  not on a provider 4xx. Exhausted jobs go to a dead-letter list in Redis.
- Every attempt is recorded in `mail_logs` with its request id, so "I got nothing"
  is answerable with a query.

**Alerts that reach you**

- Telegram, Slack and Discord channels over raw HTTPS — no package for any of them —
  plus operator mail and a console channel for development.
- Per-user opt-out per event and per channel, and a `notification_logs` row for every
  channel including the ones that refused, so a skipped alert is visible.
- A failing webhook never fails the request that triggered it.

## Stack

|            |                                                                   |
| ---------- | ----------------------------------------------------------------- |
| Framework  | NestJS 12, Express 5, Node 22+                                    |
| Language   | TypeScript, ESM, NodeNext                                         |
| Data       | PostgreSQL, TypeORM, reviewed migrations                          |
| Cache      | Redis or Valkey via `@nestjs/cache-manager`, Keyv                 |
| Auth       | JWT access and refresh tokens, TOTP 2FA                           |
| Validation | `zod` for the environment, `class-validator` for requests         |
| Docs       | Swagger at `/docs`                                                |
| Ops        | helmet, throttler, terminus health checks, Docker, GitHub Actions |

Runs on Express and on Fastify. The middleware declares the parts of the request
and reply it uses, and picks its catch-all route per adapter, because the two
routers spell a wildcard differently.

## Quick start

Full detail, including what to change before you deploy, is in
[docs/installation.md](docs/installation.md). This is the short version.

### With Docker

```bash
git clone https://github.com/VnDevTop/NestJs-Boilerplate.git
cd NestJs-Boilerplate
cp .env.example .env
docker compose up --build
```

Brings up Postgres and Valkey, runs the migrations, then starts the app. The
admin user is seeded and its password is printed once, at first start.

- API on `http://localhost:3000/api/v1`
- Docs on `http://localhost:3000/docs`

### Without Docker

```bash
npm install
cp .env.example .env          # then fill in DATABASE_URL and CACHE_URL
npm run migration:run
npm run seed                   # prints a generated admin password
npm run start:dev
```

## Scripts

```bash
npm run start:dev            # watch mode
npm run build                # compile
npm run start:prod           # run the compiled build
npm run lint                 # oxlint
npm run typecheck            # tsc --noEmit
npm test                     # unit and integration, vitest
npm run test:e2e             # end to end against real postgres and redis in containers
npm run test:cov             # unit suite with a coverage report
npm run test:mutate          # mutation testing, scoped to auth and retention
npm run test:smoke           # k6 smoke test against a running instance
npm run test:all             # unit suite, then the end-to-end suite
npm run check                # lint, typecheck, test and build, in the order CI runs them
npm run migration:generate   # write a migration from entity changes
npm run migration:run
npm run migration:revert
npm run seed
```

## Tests

Four layers, each answering a question the one above it cannot.

| Command               | Runs against       | Answers                                             |
| --------------------- | ------------------ | --------------------------------------------------- |
| `npm test`            | nothing external   | does each decision hold, in isolation               |
| `npm run test:e2e`    | real containers    | does the wired application hold, end to end         |
| `npm run test:mutate` | mutated sources    | does the test suite notice when the logic changes   |
| `npm run test:smoke`  | a running instance | does a deployed one answer the calls a client makes |

The end-to-end suite starts its own Postgres and Redis with `testcontainers`, runs
every migration against them, and hands the urls to each spec.

It needs a container runtime. Without one it does not fail — it prints the three
things that work and skips:

```bash
colima start                 # 1. start one; `docker info` is the check

docker compose up -d postgres valkey   # 2. or reuse the local stack
E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nestjs_boiler_plate \
E2E_REDIS_URL=redis://localhost:6379/1 npm run test:e2e

E2E_NO_CONTAINERS=1 npm run test:e2e   # 3. or skip, which runs nothing
```

CI deliberately omits both the opt-out flag and option 2, so a job that cannot
reach a container runtime fails rather than reporting success on a suite that
never ran.

```bash
npm run test:e2e                              # starts its own containers
E2E_NO_CONTAINERS=1 npm run test:e2e          # skips, on a machine with no docker
E2E_DATABASE_URL=postgres://... npm run test:e2e
```

Three of these suites exist because of a specific quiet failure:

- `optional-dependencies.e2e-spec.ts` boots the app with `MAIL_TRANSPORT=ses` and
  no `@aws-sdk/client-sesv2` installed. Every unit test resolves a transport that
  is present, so nothing else would catch a missing fallback.
- `cache-invalidation.e2e-spec.ts` changes a grant and re-reads on the next
  request. No assertion in it waits out a TTL, because a test that waits for an
  entry to lapse passes just as well when the invalidation is deleted.
- `retention-dry-run.e2e-spec.ts` runs the rehearsal against a real database with
  a row planted past the cutoff, and asserts the row is still there.

## Project structure

```text
src
├── configs      namespaced, typed configuration and environment validation
├── database     migrations, seeds, the standalone data source
├── common       guards, decorators, middleware, utilities
├── core         cache, health, logger, swagger
└── modules      auth, users, admin, mail, queue, maintenance, notification
```

Business features live in `modules`, each documenting itself. Technical
capabilities live in `core`. Anything reusable across features lives in `common`,
and nothing in `common` may know what your business does.

## Documentation

Each folder documents itself, so an explanation sits where you are already
looking. The `docs/` folder is also published as a site at
<https://vndevtop.github.io/NestJs-Boilerplate/>.

|                                                                |                                                           |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| [PLAN.md](PLAN.md)                                             | the phases, their status, and what is still open          |
| [ROADMAP.md](ROADMAP.md)                                       | what is shipped, open decisions, and enhancement plans    |
| [CHANGELOG.md](CHANGELOG.md)                                   | what each change did and why, per commit                  |
| [docs/](docs/)                                                 | the guides, also published as a site                      |
| [docs/installation.md](docs/installation.md)                   | installing it, the two gotchas, and how to verify it      |
| [docs/production.md](docs/production.md)                       | rate limiting, headers, CORS, logging, health, Docker, CI |
| [docs/optional-integrations.md](docs/optional-integrations.md) | how an optional dependency stays out of the install       |
| [docs/runbook.md](docs/runbook.md)                             | what to do when mail, redis or the queue misbehave        |
| [src/configs](src/configs/README.md)                           | configuration namespaces and environment validation       |
| [src/database](src/database/README.md)                         | migrations, seeds, the standalone data source             |
| [src/common](src/common/README.md)                             | guards, decorators, middleware, utilities                 |
| [src/core](src/core/README.md)                                 | technical capabilities                                    |
| [src/core/cache](src/core/cache/README.md)                     | coalescing, stale while revalidate, invalidation          |
| [src/core/health](src/core/health/README.md)                   | liveness vs readiness                                     |
| [src/core/logger](src/core/logger/README.md)                   | development colours vs production JSON                    |
| [src/modules](src/modules/README.md)                           | module rules, and an index of the per-module summaries    |
| [src/modules/auth](src/modules/auth/README.md)                 | sessions, rotation, devices, two-factor                   |
| [src/modules/users](src/modules/users/README.md)               | the user domain and its authorisation                     |
| [src/modules/admin](src/modules/admin/README.md)               | operator-only routes                                      |
| [src/modules/audit](src/modules/audit/README.md)               | what is recorded, and what deliberately is not            |
| [src/modules/mail](src/modules/mail/README.md)                 | templates, transports, the delivery record                |
| [src/modules/queue](src/modules/queue/README.md)               | the two drivers, deduplication, the dead-letter list      |
| [src/modules/maintenance](src/modules/maintenance/README.md)   | nightly retention, batching, dry run, run history         |
| [src/modules/notification](src/modules/notification/README.md) | operator alerts, channels, per-user preferences           |

## Known limitations

Recorded rather than left to be discovered. See
[ROADMAP.md](ROADMAP.md#open-decisions) for the reasoning, and
[SECURITY.md](SECURITY.md) for what to check before a real deployment.

- `GET /users/:id` has no role guard: any authenticated user can read another
  user's profile, email included. The password hash is withheld.
- A dead cache costs latency rather than correctness. Each request waits out
  `CACHE_CONNECT_TIMEOUT` for the failed read and again for the failed write.
- A role's permissions changed directly in the database are invisible to the
  application until `CACHE_AUTH_ROLE_TTL` expires, because invalidation runs where
  the write runs. Use `PUT /admin/roles/:role/permissions`, which goes through it.
- A dead Redis costs rate limiting and the login lockout, because both fail open.
  An outage that overlaps an attack removes that protection. Put a limit in front
  of the application as well; these are the inner layer, not the only one.
- The login lockout is keyed by address rather than by account row, so it counts
  attempts against addresses nobody registered. That is what keeps a 429 from
  revealing which addresses exist. The cost is that anybody can lock an address
  out by guessing it wrong five times.
- Auth state comes from Redis with a short TTL, and every write that moves an
  authentication answer drops the entry explicitly. A change made outside the
  application is therefore invisible until the TTL expires; there is no subscriber
  watching for it, because a TypeORM subscriber gets no dependency injection and
  cannot identify the row a query-builder write touched.
- The audit trail can have holes. `AuditService.record` never throws, so an outage in
  the log costs a logged gap rather than a failed request. That is a deliberate
  trade: an outage in the log must not become an outage in the product.
- A permanent lockout is a denial-of-service surface before it is a defence.
  Somebody with a list of addresses can lock twenty accounts for twenty requests
  each. What bounds it is the recovery path — only a confirmed address can be
  locked, and that account's owner receives a link that clears it without help.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Commit messages follow Conventional
Commits and are checked before the commit is created.

## Credits

- **[VnDevTop](https://github.com/VnDevTop)** — design and review.
- **[OpenCode](https://opencode.ai)** — the coding agent that implemented Phase 22
  (configurable email templates) and fixed the Phase 21 test suite.

Worth saying plainly rather than leaving it to be discovered from the commit
style: recent phases were written by an agent, and the reasoning in each commit
body is the agent's rather than a human's retrospective. Treat it as a first
draft to review, not a finished decision — particularly the security notes in
`PLAN.md`, which are arguments, not proofs.

## License

[MIT](LICENSE) © VnDevTop
