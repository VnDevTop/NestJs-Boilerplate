# Plan: NestJS Boilerplate — Production-Ready Roadmap

## Goal

Transform the current minimal NestJS scaffold into a genuinely useful, production-grade
boilerplate that can be reused across many real-world projects. Priorities:

1. Code quality and maintainability.
2. Security and compliance with international standards (HIPAA §164.312, ISO 27001, OWASP ASVS).
3. Simplicity and developer experience.
4. Reusability across cloud providers and authentication methods.

## Conventions

- Default branch: `master`.
- Branch naming: `feat/<topic>`, `docs/<topic>`, `chore/<topic>`, `ci/<topic>`.
- Commit style: Conventional Commits `type(scope): description`.
- One task per commit.
- Feature branches are merged to `master` via pull requests.
- Node.js >= 24, npm >= 11.
- Prefer official NestJS packages (`@nestjs/*`) whenever available.
- Validation uses `class-validator`, `class-transformer`, and `zod`.
- ORM uses TypeORM with PostgreSQL.

---

## Phase 1 — Foundation & Project Structure

**Branch:** `feat/project-structure`

### Tasks

1. `feat(structure): establish modular src layout`
   - Create directories:
     - `src/common/{config,decorators,dto,exceptions,filters,guards,interceptors,pipes,utils}`
     - `src/config`
     - `src/database`
     - `src/modules/{auth,users,health,mail,cache,queue,i18n,http,compliance}`
   - Add barrel exports where useful.

2. `chore(config): add configuration module and env validation`
   - Package: `@nestjs/config`
   - Add `src/config/configuration.ts` and `src/config/env.validation.ts` (Joi or class-validator).
   - Validate all required env vars at startup.

3. `chore(database): add typeorm with postgresql and base entity`
   - Packages: `@nestjs/typeorm`, `typeorm`, `pg`.
   - Configure PostgreSQL connection via `@nestjs/config`.
   - Add `src/database/base.entity.ts` with `id`, `createdAt`, `updatedAt`, `deletedAt`.
   - Add TypeORM migrations setup and initial migration.
   - Configure TypeORM in `AppModule`.

4. `docs(structure): document folder conventions`
   - Add `docs/STRUCTURE.md`.

### Validation

```bash
npm run lint
npx tsc --noEmit
npm run build
```

---

## Phase 2 — Cross-Cutting Core Packages

**Branch:** `feat/core-packages`

Maximize official NestJS packages. One commit per package.

### Tasks

1. `feat(swagger): add openapi documentation`
   - Package: `@nestjs/swagger`
   - Configure Swagger at `/api/docs`.

2. `feat(validation): add class-validator and class-transformer`
   - Packages: `class-validator`, `class-transformer`.
   - Add global `ValidationPipe` with whitelist and transform.

3. `feat(validation): add zod support`
   - Package: `zod` (and `nestjs-zod` if used).
   - Add schema validation helpers for complex payloads.

4. `feat(config): add typed configuration`
   - Already introduced in Phase 1; refine namespaces.

3. `feat(health): add terminus health checks`
   - Package: `@nestjs/terminus`
   - Add `/health` and `/health/ready`.

4. `feat(cache): add cache manager`
   - Package: `@nestjs/cache-manager` (+ `cache-manager`).
   - Provide Redis-ready cache store.

5. `feat(queue): add bullmq queues`
   - Package: `@nestjs/bullmq` (+ `bullmq`).
   - Add example mail queue.

6. `feat(mail): add mailer`
   - Package: `@nestjs/mailer` (+ `nodemailer`).
   - Add mail templates and service.

7. `feat(i18n): add internationalization`
   - Package: `@nestjs/i18n`.
   - Add locale files and language resolver.

8. `feat(http): add axios http module`
   - Package: `@nestjs/axios`.
   - Wrap external HTTP calls.

9. `feat(throttle): add rate limiting`
   - Package: `@nestjs/throttler`.

10. `feat(helmet): add security headers`
    - Use `helmet` middleware.

11. `feat(events): add event emitter`
    - Package: `@nestjs/event-emitter`.

12. `feat(schedule): add scheduler`
    - Package: `@nestjs/schedule`.

### Validation

```bash
npm run lint
npm run build
npm test
```

---

## Phase 3 — Reliability for External Calls

**Branch:** `feat/reliability`

Apply NestJS 12 reliability packages.

### Tasks

1. `feat(resilience): add resilience module`
   - Package: `@nestjs/resilience`.
   - Configure retry, timeout, circuit breaker, bulkhead, fallback.

2. `feat(resilience): configure retry and timeout policies`
   - Add reusable decorators/policies.

3. `feat(resilience): add circuit breaker and bulkhead`
   - Protect external service calls.

4. `feat(resilience): add fallback handlers`
   - Graceful degradation paths.

5. `feat(idempotency): add idempotency module`
   - Package: `@nestjs/idempotency`.
   - Add idempotency keys for external/mutation requests.

6. `test(resilience): add reliability tests`
   - Simulate failures, timeouts, retries.

### Validation

```bash
npm test
npm run test:e2e
```

---

## Phase 4 — Authentication & Security

**Branch:** `feat/auth`

### Tasks

1. `feat(users): add user entity and repository`
   - User model with email, password hash, roles, status.

2. `feat(auth): add email/password registration and login`
   - Password hashing with `argon2` or `bcrypt`.

3. `feat(auth): add jwt access and refresh tokens`
   - Package: `@nestjs/jwt`, `@nestjs/passport`, `passport`, `passport-jwt`.
   - Short-lived access tokens, rotating refresh tokens.

4. `feat(auth): add role-based access control`
   - Roles guard and decorators.

5. `feat(auth): add oidc provider abstraction (SOLID)`
   - Define `OidcProvider` interface and provider registry/factory.
   - Keep provider selection config-driven.
   - Allow enabling/disabling providers without changing core auth logic.

6. `feat(auth): implement google oidc provider`
   - Use `openid-client` behind the abstraction.

7. `feat(auth): implement microsoft oidc provider`

8. `feat(auth): implement github oidc provider`

9. `feat(auth): implement apple oidc provider`

10. `feat(auth): add client credentials flow`
   - For service-to-service authentication.

11. `feat(auth): add jwt key versioning and rotation`
    - Store signing keys with `kid` and version.
    - Support verifying tokens signed by previous keys during rotation.

12. `feat(security): add brute-force protection`
    - Account lockout / throttling on auth endpoints.

13. `feat(security): add audit logging`
    - Log auth events and sensitive actions.

14. `test(auth): add auth and security tests`

### Validation

```bash
npm test
npm run test:e2e
```

---

## Phase 5 — Compliance Framework & Checklist

**Branch:** `feat/compliance`

### Tasks

1. `feat(compliance): add compliance checklist data model`
   - Store standard, control id, description, status, evidence.

2. `feat(compliance): add hipaa checklist`
   - HIPAA §164.312 controls.

3. `feat(compliance): add iso27001 checklist`
   - ISO 27001 Annex A controls.

4. `feat(compliance): add owasp asvs checklist`
   - OWASP ASVS requirements.

5. `feat(compliance): add compliance api and dashboard`
   - Endpoint to view compliance status per standard.

6. `docs(compliance): document standards alignment`
   - Map implemented features to controls.

### Validation

```bash
npm run build
npm test
```

---

## Phase 6 — Documentation & Deployment

**Branch:** `docs/deployment`

### Tasks

1. `docs(deploy): add aws deployment guide`
   - ECS/EC2/Lambda options, scripts.

2. `docs(deploy): add gcp deployment guide`
   - Cloud Run / GKE options.

3. `docs(deploy): add azure deployment guide`
   - Container Apps / AKS options.

4. `docs(contributing): add contribution guide`
   - Branching, commits, PR process.

5. `ci(pages): build docs to github pages on release`
   - Add workflow to publish docs site.

6. `docs(readme): add badges`
   - CI, coverage, license, node version badges.

### Validation

```bash
npm run build
```

---

## Phase 7 — Soft Delete & Data Lifecycle

**Branch:** `feat/data-lifecycle`

### Tasks

1. `feat(soft-delete): add soft delete to base entities`
   - Already in base entity; add repository helpers and query filters.

2. `feat(cleanup): add scheduled hard-delete job`
   - Use `@nestjs/schedule`.
   - Purge soft-deleted records after retention period.

3. `feat(cleanup): add retention policies`
   - Configurable per entity.

4. `test(cleanup): add cleanup tests`

### Validation

```bash
npm test
```

---

## Phase 8 — Future Enhancements (Backlog)

Potential follow-ups after core is complete:

- Multi-tenancy support.
- Feature flags.
- OpenTelemetry observability.
- Admin panel.
- GraphQL module.
- Webhooks.
- File storage (S3/GCS/Azure Blob).
- Notifications (push/SMS).
- Advanced search and pagination utilities.
- API versioning strategy.

---

## Release Process (After Each Phase)

Each phase ends with a release cycle:

1. Create a pull request from the feature branch to `master`.
2. After review and successful merge, create a version tag:
   - Tag format: `v12.0.x` (increment patch per phase/release).
3. Push the tag to GitHub.
4. Create a GitHub Release with generated release notes.
5. Trigger documentation build/publish to GitHub Pages (Phase 6 workflow).

---

## Cross-Cutting Quality Gates

Every phase must pass:

```bash
npm run lint
npx tsc --noEmit
npm run build
npm test
npm run test:e2e
docker build -t nestjs-boilerplate .
```

## Risks & Notes

- OIDC providers may require app registration and secrets; keep config externalized.
- Compliance checklists are documentation/control tracking, not legal certification.
- Key rotation requires careful migration and backward compatibility.
- Soft-delete cleanup must respect retention and audit requirements.
- Prefer official NestJS packages to reduce maintenance risk.