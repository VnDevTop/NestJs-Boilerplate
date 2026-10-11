# Modules Layer

Business features. Each folder is one domain module.

```text
modules
├── auth/       sign in, sessions, devices, two-factor, permissions, lockout
├── users/      the user domain and its permissions
├── admin/      operator-only routes
├── mail/       transactional email, queued, swappable transport
├── queue/      background jobs, with an in-process fallback
├── maintenance/ nightly retention, batching, dry run
└── notification/ operator alerts to Telegram, Slack, Discord, email, log
```

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
```

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
