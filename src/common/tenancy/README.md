# The Tenancy Layer

The pieces that answer one question: **which tenant is this, and how does
everything else find out?**

```text
common/tenancy
├── tenant.constants.ts        the fixed default tenant, and the header name
├── tenant-context.service.ts  the context, on AsyncLocalStorage
├── tenant-scoped.repository.ts the base repository that only ever sees one tenant's rows
└── tenant-scope.ts            telling the database which tenant the connection is working for
```

The module that answers requests is `src/modules/tenancy` — the registry, the
middleware and the `tenants` table. This folder is the layer underneath it, and
it is deliberately free of business data: the context carries an id, a slug and
a status, and nothing else.

## The rules

- **A tenant is never defaulted into existence.** A request for a tenant that
  does not exist is a 401, not a fallback to the default tenant. Falling back
  would answer a request for somebody else's data with this deployment's rows.
- **The scope is applied at the repository, never per query.** A query that has
  to remember the tenant is a query that will forget it.
- **Row-level security is the floor, not the ceiling.** The repository scope is
  the first line; the policy is what catches the application bug that forgot it.
- **Work outside a request still has a tenant.** The default one. A seed, a
  scheduled job and a migration are not inside a tenant's context, and they
  still write somewhere specific.

## The context

`TenantContextService` holds the current tenant on `AsyncLocalStorage`, so
anything called during a request — a service, a repository, a job handler — can
ask for it without it being threaded through every signature.

```ts
const tenant = this.tenantContext.current(); // null outside a request
const tenant = this.tenantContext.require(); // throws outside a request
```

`current()` answers `null` rather than the default tenant, because "no tenant"
and "the default tenant" are different facts: the first means a job that was
never stamped, the second means a deployment with one customer. The code that
needs a tenant to write to uses `require()`.

The context is set by the tenancy middleware, before any guard runs, so a guard
that refuses a request refuses it for the right tenant.

## The repository

`TenantScopedRepository` applies the tenant to every read and every write. It
is a base class rather than a helper, so the scope cannot be left off by
accident: a method that reaches the database is a method that goes through the
scope.

The spec in this folder lists the public methods the base class exposes, and
fails when a new one appears without a scope. That is the only way the
guarantee survives the next person who adds a method.

## Telling the database

`setTenantScope()` sets `app.tenant_id` on the connection, which is what the
row-level security policies read:

```sql
USING ("tenantId" = current_setting('app.tenant_id', true))
```

The setting is transaction-local — `set_config(..., true)` — so it is undone by
the commit. A session-level setting would outlive the tenant it was set for,
and the next tenant's query would read the first tenant's rows.

Two halves, and neither replaces the other:

| Layer          | What it does                                   |
| -------------- | ---------------------------------------------- |
| The repository | says which rows the query is _asking_ for      |
| The policy     | says which rows the database will _let it see_ |

A query that forgot the filter gets an empty result rather than another
customer's data — and a query that forgot to set the scope gets an empty
result too, which is why the setting is set rather than assumed.

**Who sets it today.** The retention run does, because it is a raw query runner
and it opens its own transaction. The request path does not: TypeORM does not
open a transaction per request, and a session-level setting would outlive the
tenant it was set for on a pooled connection. So the policies bind for the
paths that set the scope, and the repository scope is what holds the line on
the paths that do not — see [the production
notes](../../../docs/production.md) for what moving the application onto the
`app_user` role would take.
