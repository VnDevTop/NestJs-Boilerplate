# Users — Introduction

The user domain and the data-subject rights that attach to it. This module owns
the `users` table, the read path that every authorisation decision depends on,
and the export route that exists because a regulation requires one.

The detailed reference is [README.md](README.md); the auth rationale is in
[../auth/README.md](../auth/README.md).

## What it owns

```text
users
├── users.controller.ts       routes
├── users.service.ts          CRUD, lock, soft delete, auth-cache invalidation
├── permissions.service.ts    role → grants, the RBAC read path
├── export/                   GET /users/me/export — the data-subject export
├── erasure.spec.ts           the right-to-be-forgotten invariants
├── dto/ entities/
```

## Routes

| Route                  | Guards                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `POST /users`          | `@Idempotent()`, `@Audited(users.create)`, `@Roles(Admin, SuperAdmin)`, `@Permissions(UserWrite)`  |
| `GET /users`           | `@Roles(Admin, SuperAdmin)` — **no permission required**                                           |
| `GET /users/me/export` | `@RequireVerifiedEmail()`, self-scoped                                                             |
| `GET /users/:id`       | **none beyond authentication**                                                                     |
| `PATCH /users/:id`     | `@Audited(users.update)`, `@Roles(Admin, SuperAdmin)`, `@Permissions(UserWrite)`                   |
| `DELETE /users/:id`    | `@Idempotent()`, `@Audited(users.delete)`, `@Roles(Admin, SuperAdmin)`, `@Permissions(UserDelete)` |

The controller binds `AuditInterceptor`, so all three privileged writes are
recorded automatically.

## Passwords

`users.password` has exactly one writer: `UsersService`, on both the create and
the update path. Both take a **plaintext** password and hash it — the client
never holds a digest, and a request body is not a place to put one. `register`,
password reset and an operator reset all converge on the same two lines.

Setting the password through `PATCH /users/:id` also bumps `sessionsVersion`,
which kills every token that account holds. An administrator resetting a password
somebody cannot reach their inbox from is closing a door the old key still
opens; without the bump the reset is cosmetic.

## Data-subject rights

### Export — `GET /users/me/export?format=csv|json`

Five sections, streamed over TypeORM cursors rather than buffered:

| Section           | Contents                                                                |
| ----------------- | ----------------------------------------------------------------------- |
| `user`            | id, email, name, role, flags, `lockedAt`, `sessionsVersion`, timestamps |
| `devices`         | id, name, ip, user agent, active, version, timestamps                   |
| `sessions`        | id, device, expiry, `revokedAt`, `revokedReason`, ip, created           |
| `notifications`   | per-event, per-channel preference flags                                 |
| `passwordHistory` | id, reason, timestamp — **never the hash**                              |

**Credentials cannot leak because they are never selected.** This is structural
rather than filtered at render time: `users.password`,
`two_factor_secrets.secretCiphertext/secretIv/secretAuthTag/recoveryCodes`,
`password_history.passwordHash` and `refresh_tokens.jti` are absent from the
column lists, so no code path could emit them even if one were added by mistake.
The `two_factor_secrets` table is not queried at all.

CSV output carries a formula-injection guard — a leading `=`, `+`, `-` or `@`
is tab-prefixed — because a user-supplied name beginning with `=` is executed by
a spreadsheet, not displayed.

Self-scoped only. There is no `GET /users/:id/export`: a route that returned
another subject's export would be a data-breach route with a permission on it.

### Erasure

`POST /auth/account/erasure` (in [auth](../auth/README.md)) and
`DELETE /users/:id` both land in `UsersService.requestDeletion`, which sets
`deletedAt` and `deletionReason`. The timestamp is stamped **on the entity**,
not accepted from the caller, so nobody can backdate it to skip the grace
window. A second request does not restart the clock.

Notification preferences are dropped immediately; the user row survives until the
retention job hard-deletes it after `RETENTION_USERS_DAYS` (default 30).

## Standards alignment

The same disclaimer as [auth](../auth/INTRODUCTION.md) applies: a technical
mapping, not a compliance claim. Both rights below are implemented as _routes_;
satisfying GDPR Article 15 or 17 in practice additionally requires a process for
responding to requests, an identity-verification policy for the requester, and a
retention schedule you have decided on.

| Requirement                                        | Status          | Notes                                                                                                                                             |
| -------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| GDPR Art. 15 — right of access                     | **implemented** | self-scoped export, credentials structurally excluded                                                                                             |
| GDPR Art. 16 — right to rectification              | **implemented** | `PATCH /users/:id`, audited                                                                                                                       |
| GDPR Art. 17 — right to erasure                    | **partial**     | soft delete + 30-day grace; `audit_logs`, `mail_logs` and `notification_logs` carry no FK and survive, pruned only by their own retention windows |
| GDPR Art. 18 — restriction on processing           | **absent**      | no flag that suppresses processing while keeping the row                                                                                          |
| HIPAA §164.312(a)(2)(i) unique user identification | **met**         | uuid + `sub`                                                                                                                                      |
| HIPAA §164.308(a)(5)(ii)(D) password management    | **partial**     | see below                                                                                                                                         |

## Known gaps

| #   | Gap                                                                                                                                                                                               | Where                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1   | `GET /users/:id` has no role guard: any authenticated user can read another user's profile including email                                                                                        | `users.controller.ts`         |
| 2   | `GET /users` requires a role but no `UserRead` permission, which exists in the catalogue                                                                                                          | `users.controller.ts`         |
| 3   | `PATCH /users/:id` can change `role`, `isActive` or `isManager` without bumping `sessionsVersion`; the change reaches the caller on the next request only because the auth cache entry is dropped | `users.service.ts` `update()` |
| 4   | The export writes **no audit row** — reading a subject's whole record is unrecorded                                                                                                               | `export/export.service.ts`    |
| 5   | Email is not normalised to lower case on write, contradicting `users/README.md`                                                                                                                   | `CreateUserDto`               |
| 6   | Names carry no `@MaxLength`, so a >100 char name surfaces a database error as a 500                                                                                                               | `create-user.dto.ts`          |

Ordered by what an operator inherits. Gap 1 is a deliberate product decision
rather than an oversight, and it is the one most likely to be closed by somebody
who reads the table as a to-do list.

## Where to go next

- [README.md](README.md) — the user domain in detail.
- [../auth/INTRODUCTION.md](../auth/INTRODUCTION.md) — where a password should
  have been hashed.
- [../maintenance/INTRODUCTION.md](../maintenance/INTRODUCTION.md) — what
  actually deletes the row.
