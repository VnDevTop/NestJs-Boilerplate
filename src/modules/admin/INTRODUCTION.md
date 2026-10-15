# Admin — Introduction

Operator surfaces: health, retention control, role grants and mail-template
editing. Everything here can change how the application behaves for everybody
else, which is why the authorisation rules are narrower than in any other
module.

The detailed reference is [README.md](README.md).

## Two-tier authority

| Tier                         | Mechanism                                                              | Grants                                                  |
| ---------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| Read the operational surface | `@ManagerOnly()` — `isManager`, plus **every** `/admin/` path by regex | viewing health, dashboards, run history                 |
| Change something             | `@Permissions(...)`                                                    | mutating a grant, editing a template, running retention |

A route needs both to be dangerous, and the regex in `ManagerGuard` means a new
`/admin/` route is manager-gated by default without anyone remembering to add a
decorator.

`role:write` — the permission that can grant an administrator more access — is
held by **SuperAdmin only**. `Admin` gets `role:read`.

## Routes

| Route                                | Guards                                         | Audited |
| ------------------------------------ | ---------------------------------------------- | ------- |
| `GET /admin/health`                  | `@ManagerOnly`, `admin:health:read`            | no      |
| `GET /admin/dashboard`               | `@ManagerOnly`, `admin:health:read`            | no      |
| `POST /admin/retention/dry-run`      | `@Roles(Admin, SuperAdmin)`, `maintenance:run` | **no**  |
| `POST /admin/retention/run`          | `@Roles(Admin, SuperAdmin)`, `maintenance:run` | **no**  |
| `GET /admin/retention/runs`          | `@ManagerOnly`                                 | no      |
| `GET /admin/retention/runs/latest`   | `@ManagerOnly`                                 | no      |
| `GET /admin/roles/:role/permissions` | `role:read`                                    | no      |
| `PUT /admin/roles/:role/permissions` | `role:write`, `@Idempotent()`                  | **yes** |
| `GET /admin/mail-templates`          | `mail-template:read`                           | no      |
| `GET /admin/mail-templates/:name`    | `mail-template:read`                           | no      |
| `POST /admin/mail-templates/preview` | `mail-template:read`                           | no      |
| `PUT /admin/mail-templates/:name`    | `mail-template:write`, `@Idempotent()`         | **yes** |
| `DELETE /admin/mail-templates/:name` | `mail-template:write`, `@Idempotent()`         | **yes** |

Unlocking a user is deliberately **not** here — `PATCH /auth/account/:id/unlock`
lives in [auth](../auth/README.md), because clearing a lock must also clear the
Redis failure count and `LoginLockoutService` lives there.

## What an operator can actually do

- **Health and dashboard** are placeholders returning hard-coded `ok`. Real
  probes are at `/api/v1/health/*` in [../../core/health](../../core/health).
- **Retention** — a dry run that counts exactly and deletes nothing, a queued
  run, and paginated history.
- **Role grants** — read a role's permissions, replace the whole set. The write
  is read-back-verified and invalidates the permission cache after commit.
- **Mail templates** — list, read with its field contract, preview, replace
  (superseded content kept in `mail_template_versions`), reset to the shipped
  file. Version-pinned, so a concurrent edit is a 409 rather than a lost update.

## Input validation on operator writes

- Unknown template name → 404 **before** any database write.
- Stored templates are compiled and checked against the helper allowlist
  **before** the write is accepted, not at render time.
- `ParseEnumPipe(Role)` on the grant route, so a grant for a role nobody holds
  cannot be written.
- Permission names validated against the catalogue; an unknown name is a 400,
  not a silent no-op.

## Standards alignment

Not a compliance claim — see [../auth/INTRODUCTION.md](../auth/INTRODUCTION.md).

| Requirement                                                       | Status      | Notes                                                                                                         |
| ----------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| HIPAA §164.308(a)(5)(ii)(B) Authorisation / supervision of access | **partial** | role and permission checks are solid; there is no periodic review of who holds what, and no log of the review |
| HIPAA §164.308(a)(3)(ii)(B) Workforce clearance                   | **not met** | no joiner/mover/leaver workflow                                                                               |
| HIPAA §164.312(a)(1) Access control — unique ID                   | **met**     | every operator action has an actor                                                                            |
| HIPAA §164.308(a)(1)(ii)(D) Activity review                       | **partial** | role changes are audited; retention runs are not                                                              |
| ISO 27001 A.9.2 Privileged access rights                          | **partial** | separation is by permission, but there is no time-boxing or just-in-time elevation                            |
| ISO 27001 A.9.4 Restriction of privileged system use              | **partial** |                                                                                                               |

### The gap that matters: no step-up authentication

Nothing in this module requires a second factor to be re-presented before a
destructive action. An operator session established hours earlier, on a laptop
that was since unattended, can hard-delete every soft-deleted user row. Every
other auth decision in the system is scoped carefully — this one is not.

HIPAA's emergency-access provision (§164.312(a)(2)(ii)) is likewise absent: there
is no break-glass identity, no justification field, no time-box, and no alert
when such access is used.

## Known gaps

| #   | Gap                                                                                                                                                                        | Where                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1   | **No step-up or re-authentication** on any route, including the ones that permanently delete data                                                                          | whole module                    |
| 2   | `POST /admin/retention/run` and `/dry-run` are **unaudited** — `AdminRetentionController` binds no interceptor, and `maintenance_logs.trigger='admin'` records no actor id | `admin/retention.controller.ts` |
| 3   | No IP allow-list or network restriction on `/admin/**`                                                                                                                     | —                               |
| 4   | No `@RequireVerifiedEmail()` on any admin route, unlike the data-subject routes                                                                                            | —                               |
| 5   | `updatedBy` is hard-coded `null` on every template save, so version history does not attribute the editor — only the audit row does                                        | `mail-templates.controller.ts`  |
| 6   | Direct SQL to `role_permissions` bypasses the cache invalidation and is invisible until `CACHE_AUTH_ROLE_TTL` expires                                                      | `roles.controller.ts`           |
| 7   | Health and dashboard return hard-coded data                                                                                                                                | `admin.service.ts`              |
| 8   | No admin route can read the [audit](../audit/INTRODUCTION.md) trail                                                                                                        | —                               |

Gaps 1 and 2 compound: an unauthenticated-again, unaudited, permanent bulk
delete.

## Where to go next

- [README.md](README.md) — route detail.
- [../audit/INTRODUCTION.md](../audit/INTRODUCTION.md) — which of these are recorded.
- [../maintenance/INTRODUCTION.md](../maintenance/INTRODUCTION.md) — what a retention run does.
