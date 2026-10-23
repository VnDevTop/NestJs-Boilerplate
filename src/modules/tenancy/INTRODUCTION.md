# Tenancy — Introduction

The tenant registry and the resolution of a request to a tenant. This module
answers one question — _which tenant is this?_ — and everything else in the
application asks it.

The detailed reference is [README.md](README.md).

## What it does

- Holds the `tenants` table: slug, name, status, plan, and where its data lives
- Resolves a request to a tenant from a header, or from the host when the
  deployment has a base domain
- Puts the tenant on the request context before any guard runs
- Seeds one fixed tenant, so a single-tenant deployment has a row to look at

## The rules

| Rule                                           | Why                                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| An unknown tenant is a 401                     | Falling back to the default tenant would answer a request for somebody else's data with this one's rows                 |
| A disabled tenant is a 401                     | The point of disabling a tenant is that its data stops being reachable                                                  |
| The header wins over the host                  | The header is explicit; the host is inferred, so it is only used where the deployment has said what its hosts look like |
| The default tenant is a constant, not a lookup | A request that arrives with the feature off must still be answered, even in a database nobody has seeded                |

## The surface

Nothing here is a route. The module is infrastructure: a middleware, a
registry, and the context it fills in. The rest of the application reads the
tenant from `TenantContextService` — see
[the tenancy layer](../../common/tenancy/README.md) for what that means and
where the scope is applied.

## What it does not do

- **It does not decide who may act.** Authorisation is the auth module's job. A
  tenant says whose data this is; a role says what the caller may do with it.
- **It does not create schemas.** A tenant's `schemaName` is recorded, and
  nothing reads it yet. Per-schema isolation is its own refactor, and the
  column is there so the migration is not the thing that blocks it.
- **It does not replace the repository scope or the row-level security.** It is
  the layer above both: it decides _which_ tenant, and the layers underneath
  enforce it.
