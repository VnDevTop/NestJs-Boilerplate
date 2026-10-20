# Modules Layer

Business features. Each folder is one domain module.

```text
modules
├── auth/       sign in, sessions, devices, two-factor, permissions, lockout
├── users/      the user domain and its permissions
├── admin/      operator-only routes
├── audit/      who did what, to which row, from where
├── mail/       transactional email, queued, swappable transport
├── queue/      background jobs, with an in-process fallback
├── maintenance/ nightly retention, batching, dry run
└── notification/ operator alerts to Telegram, Slack, Discord, email, log
```

Each module has two documents. `INTRODUCTION.md` is the consolidated summary: the
feature list, the mapping to HIPAA §164.312 / ISO 27001 / OWASP ASVS, and an
honest gap table. `README.md` is the detailed reference explaining _why_ each
decision is what it is.

| Module                                       | Introduction                                         |
| -------------------------------------------- | ---------------------------------------------------- |
| [auth](auth/INTRODUCTION.md)                 | identity, sessions, authorisation, standards mapping |
| [users](users/INTRODUCTION.md)               | the user domain, data-subject rights                 |
| [admin](admin/INTRODUCTION.md)               | operator surfaces and narrow authorisation           |
| [audit](audit/INTRODUCTION.md)               | the privileged-action trail                          |
| [mail](mail/INTRODUCTION.md)                 | templates, transports, delivery records              |
| [queue](queue/INTRODUCTION.md)               | drivers, retry, idempotency                          |
| [maintenance](maintenance/INTRODUCTION.md)   | retention, batching, rehearsal                       |
| [notification](notification/INTRODUCTION.md) | operator alerts and opt-out                          |

**The standards mappings are technical, not compliance claims.** A control being
present is one input to an assessment; HIPAA compliance additionally requires
administrative and physical safeguards, policies, training, a risk analysis and
a Business Associate Agreement, none of which are software. Where a control is
partial or absent, the table says so.

## Rules

- Controllers are thin. They validate, delegate and shape the response.
- Business logic lives in services, not in controllers or entities.
- DTOs, entities, strategies and types stay inside their own module. Nothing
  imports `modules/auth/entities` from elsewhere.
- Export only what another module needs; everything else is module private.
- A module may import from `common` and `core`. It must not import from another
  feature module's internals, and circular module dependencies are a bug.
- Generic framework utilities belong in `common` or `core`, not here.
- A module that needs the job queue cannot be imported _by_ the queue module. When
  the work needs both — which is the shape of every module with a queue job —
  it splits in two: the part that does the work goes below, the part that enqueues
  goes above, and a third module above holds the cron or the route that triggers
  it. `notification.graph.spec.ts` asserts the split, because a cycle does not
  fail a test, it fails at boot naming a provider rather than the import that
  caused it.

## Routes

Base path is `/api/v1`, set in `src/main.ts` from `API_PREFIX` and `API_VERSION`.

### Public

```text
POST   /auth/register
POST   /auth/login
POST   /auth/2fa/login
POST   /auth/refresh-token
POST   /auth/logout
POST   /auth/2fa/setup
POST   /auth/2fa/verify
POST   /auth/account/unlock
POST   /auth/account/unlock/:token
POST   /auth/account/erasure
GET    /health/live
GET    /health/ready
```

### Authenticated

Routes marked ▲ also require a confirmed address. See
[src/modules/auth/README.md](src/modules/auth/README.md) for which ones and why.

```text
GET    /auth/me
GET    /users/me/export   ▲   CSV or NDJSON, streamed
GET    /auth/devices
DELETE /auth/devices/:id
POST   /auth/logout-all
POST   /auth/2fa/setup      ▲
POST   /auth/2fa/verify     ▲
POST   /auth/2fa/disable    ▲
POST   /auth/refresh-token  ▲
GET    /users/:id
GET    /notifications/preferences
PATCH  /notifications/preferences
```

### Admin or super admin

```text
POST   /users
GET    /users
PATCH  /users/:id
DELETE /users/:id
PATCH  /auth/account/:id/unlock
GET    /jobs/:id
```

`GET /jobs/:id` needs `job:read`, which the administrator holds. Watching a job
changes nothing.

### Super admin

```text
POST   /jobs/:id/cancel
```

`POST /jobs/:id/cancel` needs `job:cancel`, which only the super administrator
holds: stopping a job is irreversible and leaves the work half done. Watching and
stopping are two permissions because they are two different capabilities — see
[src/modules/queue/README.md](src/modules/queue/README.md).

### Manager, via `@ManagerOnly()` on the controller

```text
GET    /admin/health
GET    /admin/dashboard
```

### Known gap

`GET /users/:id` carries no role guard, so **any authenticated user can read any
other user's profile**, including their email address. `UserResponseDto` does
withhold the password hash, so this leaks contact details rather than
credentials, but it is still not a deliberate policy. Restricting it to the
record's owner, or to an admin, is a decision left open in
`src/modules/users/README.md`.

## Adding a module

1. `src/modules/<name>/` with `dto/`, `entities/` and a `README.md`.
2. `index.ts` exporting only the public surface, and re-export the module from
   `src/modules/index.ts`.
3. Register it in `app.module.ts`.
4. Guards: default to authenticated. Mark the route `@Public()` only when it has
   to work without a token, and `@Throttle` it tighter if it accepts a password,
   a code or anything guessable.

## Import rules

Two, and both are checked by `module-graph.spec.ts` on every commit.

**No value-import cycles.** A cycle means two modules evaluate in whatever order
the loader picks. Under `node dist/main` that order happens to work; under vitest
it does not, and the failure is reported as a missing provider rather than as an
import problem:

```text
Nest cannot create the QueueModule instance.
The module at index [2] of the QueueModule "imports" array is undefined.
```

That is exactly how this repository broke: `QueueModule` reached the retention
module through `maintenance/index.js`, and that barrel also re-exports
`MaintenanceSchedulerModule`, which imports `QueueModule` back.

`import type` is not a cycle — the compiler erases it — so the templates and the
maintenance log entity are allowed to refer to each other's types.

**A module is imported from its file, not from its folder's barrel.** A barrel
evaluates every file it re-exports, which is how a cycle appears out of a line
that reads like nothing. `JOB_QUEUE` lives in `queue.tokens.ts` for the same
reason: a token is a string, and reading one should not evaluate the queue graph
to get it.

## A module imports what it injects

`AppModule` importing a module makes that module's providers available to
`AppModule`. It does not make them available to anything else, and neither does
one module importing another:

- a provider has to be in the module's own `providers`, or come from a module in
  its `imports` that **exports** it;
- `ConfigModule.forFeature(x)` registers `CONFIGURATION(x)` for the module that
  calls it, so every module registers the configuration it injects;
- `ThrottlerModule.forRootAsync` resolves its `inject` list in its own context,
  so the module supplying the storage goes in that call's `imports`;
- an interface cannot be an injection token, and neither can anything imported
  with `import type` — the compiler erases it and Nest receives `Object`.

Each of those was a boot-time failure that every unit test passed straight
through, because a unit test builds the service and never goes near the injector.
`src/app.module.spec.ts` builds the whole graph with a stubbed data source, and
is the reason the last six of them cannot reach a deploy again.
