<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>
<p align="center">
  <a href="https://github.com/VnDevTop/NestJs-Boilerplate/actions/workflows/ci.yml"><img src="https://github.com/VnDevTop/NestJs-Boilerplate/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/VnDevTop/NestJs-Boilerplate"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="https://github.com/VnDevTop/NestJs-Boilerplate"><img src="https://img.shields.io/badge/node-%3E%3D22-5FA04E" alt="Node 22+" /></a>
  <a href="https://github.com/VnDevTop/NestJs-Boilerplate"><img src="https://img.shields.io/badge/typescript-6.0-3178C6" alt="TypeScript" /></a>
  <a href="https://github.com/VnDevTop/NestJs-Boilerplate"><img src="https://img.shields.io/badge/tests-1962%20unit%20%2B%2037%20e2e-5FA04E" alt="Tests" /></a>
</p>

# NestJS Boilerplate

Production-ready NestJS 12 boilerplate for APIs that need authentication done
properly. The session handling, the authorisation and the deployment defaults are
already built and explained, so a new project starts from working code instead of
a scaffold.

Deliberately not a framework: there is no string of configuration objects, no
opinion on your domain, and no folder you have to fight. What is here is the
part that every real API needs and that is tedious to get right, and nothing
else.

## Table of Contents

- [Important](#important)
- [TODO / Next Features](#todo--next-features)
- [Prerequisites](#prerequisites)
- [Build with](#build-with)
- [Objective](#objective)
- [Features](#features)
- [Quick Start](#quick-start)
- [Database](#database)
- [Installation](#installation)
- [Scripts](#scripts)
- [Tests](#tests)
- [Project structure](#project-structure)
- [Documentation](#documentation)
- [Known limitations](#known-limitations)
- [Contributing](#contributing)
- [License](#license)
- [Credits](#credits)

## Important

- Copy `.env.example` to `.env` and fill in the secrets. Configuration is
  validated before anything connects, so a missing value is one clear error at
  boot.
- Docker Compose brings up Postgres and Valkey, runs the migrations, then starts
  the app. The admin user is seeded and its password is printed once, at first
  start.
- `synchronize` is off. Schema changes go through reviewed migrations.
- The app runs on both Express and Fastify.

## TODO / Next Features

See [ROADMAP.md](ROADMAP.md) and [PLAN.md](PLAN.md) for open decisions and
planned enhancements.

## Prerequisites

- Node.js >= 22
- npm (packageManager `npm@11.19.0`)
- Docker (recommended, optional)
- PostgreSQL 17 and Valkey 8 (via Docker Compose)

## Build with

| Name              | Version |
| ----------------- | ------- |
| NestJS            | 12.x    |
| Node.js           | >= 22   |
| TypeScript        | 6.0.x   |
| TypeORM           | latest  |
| PostgreSQL        | 17      |
| Valkey/Redis      | 8       |
| Express / Fastify | 5 / 5   |
| Vitest            | 4.x     |

## Objective

- Modular, component-based folder structure
- Stateful authentication with rotating refresh tokens, device tracking, TOTP 2FA
- RBAC backed by a `permissions` table and a `role_permissions` join
- Twelve-Factor configuration, Redis/Valkey cache, distributed rate limiting
- Transactional mail, operator alerts, observability
- Reviewed migrations, graceful shutdown, two-stage Docker image

## Features

### Authentication & Security

- JWT access token with a rotating refresh token pair
- Rotation inside a transaction with a row lock
- Replaying a rotated-out token is treated as theft and revokes every session
- Devices fingerprinted by user agent
- Optional TOTP two-factor, secret encrypted at rest, single-use steps, recovery codes shown once
- `GET /auth/sessions` and `DELETE /auth/sessions/:id`
- Four levels of revocation: account, device, session, user row
- Two rate limits on credential routes: per client address and per submitted address
- Two account lockouts: temporary Redis block and permanent lockout
- Password policy configured by environment, optional `zxcvbn`, breach check, reuse prevention
- Append-only audit trail
- `Idempotency-Key` header on mutating routes
- Optimistic concurrency on rows read before write
- Erasure with a thirty day grace window and streamed export
- Nightly data retention with dry run
- Request id on every response, JSON logs in production
- Liveness and readiness probes kept separate

### Authorisation

- `@Roles()`, `@ManagerOnly()` and a real `@Permissions()`
- Deny by default
- Guards read the request context
- Admin scope guarded at the controller

### Platform

- Namespaced, typed configuration with environment validation at boot
- Redis or Valkey cache with request coalescing and stale-while-revalidate
- Rate limiting counted in Redis
- Prometheus metrics, OpenTelemetry spans, Sentry error reporting, each optional and off by default

### Mail

- Nine templates that take exactly the fields they render
- Pluggable transport: memory, SMTP, SES, SendGrid
- Queued, deduplicated, retried on timeouts and 5xx
- Every attempt recorded in `mail_logs`

### Alerts

- Telegram, Slack, Discord, operator mail and console channels
- Per-user opt-out per event and per channel
- `notification_logs` row for every channel

### Observability

- Liveness and readiness probes
- Prometheus metrics
- OpenTelemetry spans
- Sentry error reporting

### Development

- NestJS 12, Express 5, Node 22+
- TypeScript, ESM, NodeNext
- Swagger at `/docs`
- `zod` for the environment, `class-validator` for requests
- Vitest, oxlint, husky, commitlint
- Docker and GitHub Actions

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

## Database

Migrations run with `synchronize` off. The seed is idempotent. The database name
defaults to `nestjs_boilerplate`.

## Installation

See [docs/installation.md](docs/installation.md) for installing it, the two
gotchas, and how to verify it.

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

The end-to-end suite starts its own Postgres and Redis with `testcontainers`,
runs every migration against them, and hands the urls to each spec.

It needs a container runtime. Without one it does not fail — it prints the three
things that work and skips:

```bash
colima start                 # 1. start one; `docker info` is the check

docker compose up -d postgres valkey   # 2. or reuse the local stack
E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nestjs_boilerplate \
E2E_REDIS_URL=redis://localhost:6379/1 npm run test:e2e

E2E_NO_CONTAINERS=1 npm run test:e2e   # 3. or skip, which runs nothing
```

CI deliberately omits both the opt-out flag and option 2, so a job that cannot
reach a container runtime fails rather than reporting success on a suite that
never ran.

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

|                                                                |                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------ |
| [PLAN.md](PLAN.md)                                             | the phases, their status, and what is still open                   |
| [ROADMAP.md](ROADMAP.md)                                       | what is shipped, open decisions, and enhancement plans             |
| [CHANGELOG.md](CHANGELOG.md)                                   | what each change did and why, per commit                           |
| [docs/](docs/)                                                 | the guides, also published as a site                               |
| [docs/installation.md](docs/installation.md)                   | installing it, the two gotchas, and how to verify it               |
| [docs/production.md](docs/production.md)                       | rate limiting, headers, CORS, logging, health, Docker, CI          |
| [docs/optional-integrations.md](docs/optional-integrations.md) | how an optional dependency stays out of the install                |
| [docs/runbook.md](docs/runbook.md)                             | what to do when mail, redis or the queue misbehave                 |
| [src/configs](src/configs/README.md)                           | configuration namespaces and environment validation                |
| [src/database](src/database/README.md)                         | migrations, seeds, the standalone data source                      |
| [src/common](src/common/README.md)                             | guards, decorators, middleware, utilities                          |
| [src/core](src/core/README.md)                                 | technical capabilities                                             |
| [src/core/cache](src/core/cache/README.md)                     | coalescing, stale while revalidate, invalidation                   |
| [src/core/health](src/core/health/README.md)                   | liveness vs readiness                                              |
| [src/core/logger](src/core/logger/README.md)                   | development colours vs production JSON                             |
| [src/modules](src/modules/README.md)                           | module rules, and an index of the per-module summaries             |
| [src/modules/auth](src/modules/auth/README.md)                 | sessions, rotation, devices, two-factor                            |
| [src/modules/users](src/modules/users/README.md)               | the user domain and its authorisation                              |
| [src/modules/admin](src/modules/admin/README.md)               | operator-only routes                                               |
| [src/modules/audit](src/modules/audit/README.md)               | what is recorded, and what deliberately is not                     |
| [src/modules/mail](src/modules/mail/README.md)                 | templates, transports, the delivery record                         |
| [src/modules/queue](src/modules/queue/README.md)               | the two drivers, deduplication, job progress, the dead-letter list |
| [src/modules/maintenance](src/modules/maintenance/README.md)   | nightly retention, batching, dry run, run history                  |
| [src/modules/notification](src/modules/notification/README.md) | operator alerts, channels, per-user preferences                    |

## Known limitations

Recorded rather than left to be discovered. See
[ROADMAP.md](ROADMAP.md#open-decisions) for the reasoning, and
[SECURITY.md](SECURITY.md) for what to check before a real deployment.

- `GET /users/:id` has no role guard: any authenticated user can read another
  user's profile, email included. The password hash is withheld.
- A dead cache costs latency rather than correctness.
- A role's permissions changed directly in the database are invisible until
  `CACHE_AUTH_ROLE_TTL` expires.
- A dead Redis costs rate limiting and the login lockout, because both fail open.
- The login lockout is keyed by address rather than by account row.
- Auth state comes from Redis with a short TTL.
- The audit trail can have holes.
- A permanent lockout is a denial-of-service surface before it is a defence.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Commit messages follow Conventional
Commits and are checked before the commit is created.

## License

[MIT](LICENSE) © VnDevTop

## Credits

- **[VnDevTop](https://github.com/VnDevTop)** — design and review.
- **[OpenCode](https://opencode.ai)** — the coding agent that implemented Phase 22
  (configurable email templates) and fixed the Phase 21 test suite.

Worth saying plainly rather than leaving it to be discovered from the commit
style: recent phases were written by an agent, and the reasoning in each commit
body is the agent's rather than a human's retrospective. Treat it as a first
draft to review, not a finished decision — particularly the security notes in
`PLAN.md`, which are arguments, not proofs.
