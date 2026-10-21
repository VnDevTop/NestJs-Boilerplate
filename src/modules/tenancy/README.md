# Tenancy

The tenant registry, and the resolution of a request to a tenant.

```text
modules/tenancy
├── entities/tenant.entity.ts   the tenants table
├── tenant-registry.service.ts  the lookup: by slug, by id, the default
├── tenant.middleware.ts        the resolution, and the context it fills in
└── tenancy.module.ts           global, so anything may ask for the tenant
```

## The table

| Column       | Meaning                                                              |
| ------------ | -------------------------------------------------------------------- |
| `slug`       | the name a request carries: `acme` in `X-Tenant: acme`               |
| `name`       | what an operator sees                                                |
| `status`     | `active` is served, anything else is refused                         |
| `plan`       | what the tenant is on — free information today, the hook for billing |
| `schemaName` | where the tenant's data lives, when it is not the default schema     |

The slug is unique, because it is what a request carries and two tenants
answering to the same slug is two tenants answering to the same request.

## Resolution

1. **The header**, when the deployment is configured to accept one. Explicit,
   and the only thing a client can set to choose its own tenant.
2. **The host**, when `TENANCY_BASE_DOMAIN` is set. The subdomain is the slug.
   This is inference, so it only happens where the deployment has said what its
   hosts look like.
3. **The default tenant**, when the feature is off. A single-tenant deployment
   answers every request, which is what it did before this module existed.

The resolved tenant has to exist and has to be active. Neither failure falls
back to the default: the first is a request for a tenant that does not exist,
and the second is a request for a tenant that was told to stop being reachable.
Both are a 401.

## The context

The middleware resolves the tenant and puts it on the request context before
any guard runs, so a guard that refuses a request refuses it for the right
tenant rather than for no tenant at all.

`TenantContextService` is the reader. It answers `null` outside a request,
because "no tenant" and "the default tenant" are different facts: the first
means a job that was never stamped, the second means a deployment with one
customer. The code that has to write somewhere specific uses `require()`.

The context is global — `TenancyModule` is `@Global()` — because the
alternative is every module importing it, and a module that cannot ask which
tenant it is serving is a module that will guess.

## The default tenant

`DEFAULT_TENANT_ID` is a constant, not a row that has to exist. The seeder
writes the row so an operator can see it and so the foreign keys have
something to point at, but a request that arrives with the feature off is
answered in a database nobody has seeded.

## What this module does not do

- **It does not authorise.** A tenant says whose data this is; a role says
  what the caller may do with it.
- **It does not create schemas.** `schemaName` is recorded and nothing reads it
  yet.
- **It does not enforce isolation on its own.** The repository scope and the
  row-level security policies do that; this module decides _which_ tenant, and
  they enforce it.
