> **Start with [INTRODUCTION.md](INTRODUCTION.md)** — operator surfaces, and where authorisation is narrowest. This file is the detailed reference for _why_ each decision is what
> it is.

# Admin

Operator-only routes, kept in their own module so the scope is obvious from the
path.

```text
admin
├── admin.controller.ts
├── admin.service.ts
├── dto/            dashboard and health responses
└── interfaces/     the shapes behind them
```

## Access

`@ManagerOnly()` sits on the controller, so every route inherits it. A new route
added here is protected by default rather than by remembering a decorator, which
is the point of putting it at that level.

The check is on `isManager`, and `RolesGuard` runs as well, so a route that needs
a specific role adds `@Roles(...)` on top.

## Routes

```text
GET /admin/health      liveness of the admin module itself
GET /admin/dashboard   placeholder data
```

Both are scaffolding at present. `admin.service.ts` is where real counts and
aggregates belong, and the DTOs are declared so the response shape is set before
there is anything to return.

## Not a cache of `/health`

`GET /admin/health` is about this module and returns static status. The
application-wide probes are at `GET /api/v1/health/*` and are handled by
`core/health`. Keeping them apart means an operator can tell "the admin module
loaded" from "the database is reachable".
