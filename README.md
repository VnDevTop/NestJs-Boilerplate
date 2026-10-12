<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>
<p align="center">
  <a href="https://github.com/VnDevTop/NestJs-Boilerplate"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="https://github.com/VnDevTop/NestJs-Boilerplate"><img src="https://img.shields.io/badge/node-%3E%3D22-5FA04E" alt="Node 22+" /></a>
  <a href="https://github.com/VnDevTop/NestJs-Boilerplate/actions"><img src="https://img.shields.io/badge/CI-passing-brightgreen" alt="CI" /></a>
</p>

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
npm test                     # vitest
npm run check                # all four, in the order CI runs them
npm run migration:generate   # write a migration from entity changes
npm run migration:run
npm run migration:revert
npm run seed
```

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
| [docs/production.md](docs/production.md)                       | rate limiting, headers, CORS, logging, health, Docker, CI |
| [docs/optional-integrations.md](docs/optional-integrations.md) | how an optional dependency stays out of the install       |
| [src/configs](src/configs/README.md)                           | configuration namespaces and environment validation       |
| [src/database](src/database/README.md)                         | migrations, seeds, the standalone data source             |
| [src/common](src/common/README.md)                             | guards, decorators, middleware, utilities                 |
| [src/core](src/core/README.md)                                 | technical capabilities                                    |
| [src/core/cache](src/core/cache/README.md)                     | coalescing, stale while revalidate, invalidation          |
| [src/core/health](src/core/health/README.md)                   | liveness vs readiness                                     |
| [src/core/logger](src/core/logger/README.md)                   | development colours vs production JSON                    |
| [src/modules](src/modules/README.md)                           | module rules and the full route list                      |
| [src/modules/auth](src/modules/auth/README.md)                 | sessions, rotation, devices, two-factor                   |
| [src/modules/users](src/modules/users/README.md)               | the user domain and its authorisation                     |
| [src/modules/admin](src/modules/admin/README.md)               | operator-only routes                                      |
| [src/modules/maintenance](src/modules/maintenance/README.md)   | nightly retention, batching, dry run, run history         |
| [src/modules/notification](src/modules/notification/README.md) | operator alerts, channels, per-user preferences           |

## Known limitations

Recorded rather than left to be discovered. See
[ROADMAP.md](ROADMAP.md#open-decisions) for the reasoning, and
[SECURITY.md](SECURITY.md) for what to check before a real deployment.

- `GET /users/:id` has no role guard: any authenticated user can read another
  user's profile, email included. The password hash is withheld.
- Listing routes return every matching row, with no pagination yet.
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

## License

[MIT](LICENSE) © VnDevTop
