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
properly. Session handling, authorisation, and deployment defaults are already
built and explained, so a new project starts from working code instead of a
scaffold.

## Ideal For

- 🏢 **Enterprise apps** - auth with roles, permissions, and an audit trail
- 🔐 **Auth services** - JWT, TOTP 2FA, session revocation
- 📱 **API backends** - REST API with hardened defaults
- 🚀 **Startup MVPs** - auth, mail, queue, and observability already wired

## Important

- Copy `.env.example` to `.env` and fill in the secrets. Configuration is
  validated before anything connects.
- Docker Compose brings up Postgres and Valkey, runs migrations, then starts the
  app. The admin password is printed once, at first start.
- `synchronize` is off; schema changes go through reviewed migrations.
- Runs on Fastify.

## TODO / Next Features

See [ROADMAP.md](ROADMAP.md) and [PLAN.md](PLAN.md).

## Prerequisites

- Node.js >= 22
- npm (`npm@11.19.0`)
- Docker (recommended)

## Build with

| Name         | Version |
| ------------ | ------- |
| NestJS       | 12.x    |
| Node.js      | >= 22   |
| TypeScript   | 6.0.x   |
| TypeORM      | latest  |
| PostgreSQL   | 17      |
| Valkey/Redis | 8       |
| Vitest       | 4.x     |

## Objective

- Modular, component-based folder structure
- Stateful auth with rotating refresh tokens, device tracking, TOTP 2FA
- RBAC backed by a `permissions` table
- Twelve-Factor config, distributed rate limiting, Redis/Valkey cache
- Transactional mail, operator alerts, observability
- Reviewed migrations, graceful shutdown, two-stage Docker image

## Features

### 🔐 Authentication & Security

- JWT access + rotating refresh tokens, theft detection, device fingerprinting
- TOTP 2FA with encrypted secrets and recovery codes
- Four levels of revocation (account, device, session, user)
- Two rate limits on credential routes (per IP and per account)
- Two account lockouts (temporary + permanent)
- Password policy, breach check, reuse prevention
- Audit trail, idempotency, optimistic concurrency, erasure/export, retention
- Request id, JSON logs, liveness/readiness probes

### 🛡️ Authorisation

- `@Roles()`, `@ManagerOnly()`, `@Permissions()` backed by DB
- Deny by default
- Admin scope guarded at the controller

### ⚙️ Platform

- Namespaced, typed config with env validation at boot
- Redis/Valkey cache with coalescing and stale-while-revalidate
- Distributed rate limiting in Redis
- Prometheus, OpenTelemetry, Sentry (optional, off by default)

### ✉️ Mail

- Nine templates, pluggable transports (memory, SMTP, SES, SendGrid)
- Queued, deduplicated, retried, dead-letter list
- Every attempt recorded in `mail_logs`

### 📣 Alerts

- Telegram, Slack, Discord, operator mail, console channels
- Per-user opt-out, `notification_logs` for every channel

### 📊 Observability

- Health checks, metrics, tracing, Sentry

### 🛠 Development

- NestJS 12, TypeScript 6, ESM/NodeNext
- Swagger at `/docs`
- `zod` + `class-validator`
- Vitest, oxlint, husky, commitlint
- Docker + GitHub Actions

## Quick Start

### With Docker

```bash
git clone https://github.com/VnDevTop/NestJs-Boilerplate.git
cd NestJs-Boilerplate
cp .env.example .env
docker compose up --build
```

API on `http://localhost:3000/api/v1`, docs on `http://localhost:3000/docs`.

### Without Docker

```bash
npm install
cp .env.example .env
npm run migration:run
npm run seed
npm run start:dev
```

## Database

Migrations with `synchronize` off. Idempotent seed. Default DB name:
`nestjs_boilerplate`.

## Installation

See [docs/installation.md](docs/installation.md).

## Scripts

```bash
npm run start:dev | build | start:prod | lint | typecheck | test | test:e2e
npm run test:cov | test:mutate | test:smoke | test:all | check
npm run migration:generate | migration:run | migration:revert | seed
```

## Tests

Four layers: unit (`npm test`), e2e against real containers
(`npm run test:e2e`), mutation (`npm run test:mutate`), smoke (`npm run test:smoke`).

## Project structure

```text
src
├── configs
├── database
├── common
├── core
└── modules
```

## Documentation

See [docs/](docs/) and the per-folder READMEs. Published site:
<https://vndevtop.github.io/NestJs-Boilerplate/>.

## Known limitations

See [ROADMAP.md](ROADMAP.md#open-decisions) and [SECURITY.md](SECURITY.md).

- `GET /users/:id` has no role guard.
- A dead cache costs latency, not correctness.
- Role permission changes need `CACHE_AUTH_ROLE_TTL` to expire.
- A dead Redis disables rate limiting and login lockout (fail open).
- Audit trail can have holes by design.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Conventional Commits enforced.

## License

[MIT](LICENSE) © VnDevTop

## Credits

- **[VnDevTop](https://github.com/VnDevTop)** — design and review.
- **[OpenCode](https://opencode.ai)** — coding agent for recent phases.

## Contact

VnDevTop — <https://github.com/VnDevTop>
