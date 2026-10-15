# Auth — Introduction

A consolidated view of what this module standardises: how a caller proves who
they are, what they are allowed to touch, and where the boundaries of that
guarantee stop.

The detailed README next to this file ([README.md](README.md)) is the reference —
it explains _why_ each decision is the way it is, and the reasoning is worth
reading before changing any of it. This document is the summary and the
standards map.

## What the module covers

```text
auth
├── auth.controller.ts        sign-in, refresh, sessions, devices
├── account-lock.controller.ts  unlock, erasure, operator unlock
├── auth.service.ts           register, login, token issuing
├── refresh-token.service.ts  rotation, revocation, theft detection
├── device.service.ts         fingerprinting and per-device revocation
├── two-factor.service.ts     TOTP, recovery codes
├── password-policy.service.ts   length, complexity, reuse
├── password-breach.service.ts   k-anonymity breach lookup
├── password-history.service.ts  last-N hashes
├── password-reset.service.ts    reset tokens, history, revocation
├── login-lockout.service.ts     temporary Redis block
├── account-lock.service.ts      permanent lock, self-service unlock
├── email-verification.service.ts
├── strategies/               jwt.strategy.ts — the only authenticator
├── dto/ entities/ enums/ types/
```

## Authentication

### Credentials

| Control                    | Implementation                                                                                                   | Configuration                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Password hashing           | scrypt, 16-byte random salt, `timingSafeEqual` compare ([password.util.ts](../../common/utils/password.util.ts)) | cost parameters are Node's defaults, not stored per hash                              |
| Password length            | 8–128 by default                                                                                                 | `PASSWORD_MIN_LENGTH`, `PASSWORD_MAX_LENGTH`                                          |
| Character classes          | lowercase, uppercase, digit, symbol — each independently switchable                                              | `PASSWORD_REQUIRE_LOWERCASE`, `_UPPERCASE`, `_NUMBER`, `_SYMBOL`                      |
| Reuse prevention           | last 5 hashes retained, rejected on reset                                                                        | `PASSWORD_HISTORY_COUNT`                                                              |
| Strength scoring           | zxcvbn, score ≥ 2                                                                                                | **off in a default clone** — `zxcvbn` is not a dependency                             |
| Breached-password check    | SHA-1 prefix (5 chars) to `api.pwnedpasswords.com`, count cached 30 days, fails open                             | **off by default** — `PASSWORD_CHECK_BREACH_LIST=false`                               |
| Account lockout, temporary | 5 failures, +1 min each, capped at 15, keyed by address in Redis, fails open                                     | thresholds hard-coded                                                                 |
| Account lockout, permanent | 20 failures in 24 h, `users.lockedAt`, self-service unlock by mail                                               | `ACCOUNT_PERMANENT_LOCK_THRESHOLD`, `_WINDOW_HOURS`, `ACCOUNT_UNLOCK_TOKEN_TTL_HOURS` |

Single enforcement choke point: `PasswordPolicyService`, reached from
registration through `AuthService.assertPasswordAcceptable` and from password
reset through `checkForUser` — the one that also asks whether the account has used
it before. The reuse half needs an identity, and a reset token is the only thing
that establishes one before the transaction runs.

> `UsersService` is the only writer of `users.password`, on both the create and
> the update path, and both hash a plaintext the client supplied. `register`,
> password reset and an operator reset all reach the same column.

### Second factor

Optional, off with `TWO_FACTOR_ENABLED=false`.

- TOTP, 6 digits / 30 s / SHA1, one-step window.
- Shared secret encrypted with **AES-256-GCM**, fresh 12-byte IV, auth tag
  verified on read; key from `TWO_FACTOR_ENCRYPTION_KEY`.
- Single-use: the last accepted counter is persisted, so a code replayed inside
  its own window is rejected.
- Ten recovery codes, Crockford base32, scrypt with a per-code salt, shown once,
  removed as spent.
- Five failures lock verification for 15 minutes.
- `POST /auth/login` answers **HTTP 200 with a challenge token**, not a 401, so
  an enabled second factor is not a discovery oracle.

### Sessions

| Property                  | Value                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| Access token              | JWT, stateless, `JWT_EXPIRES_IN` default `15m`                                            |
| Refresh token             | rotating JWT, `JWT_REFRESH_EXPIRES_IN` default `7d`                                       |
| Rotation                  | inside a transaction with `pessimistic_write`, so concurrent refreshes produce one winner |
| Reuse detection           | replaying a token revoked with reason `Rotated` revokes **every** session of that user    |
| Revocation scopes         | account (`sv`), device (`dv`), session (`sid`), user row                                  |
| Idle timeout              | **not implemented**                                                                       |
| Absolute session lifetime | **not implemented** — a chain refreshed every 6 days lives indefinitely                   |

Revocation is four counters compared per request, not a lookup, so it survives
replicas. Each is scoped to something smaller than the one above it.

### Rate limiting

Counted in Redis through a Lua script, so the limit holds across replicas and a
read-then-write race cannot let two requests both pass. It **fails open**: a dead
Redis allows the request, because failing closed would turn a cache outage into
an outage of the login route.

Credential routes get two buckets — per client address _and_ per submitted
email address — because neither alone stops both host rotation and account
spraying. The per-email limits are opt-in via `@RateLimit('group')`, so a bucket
declared only in `@Throttle()` is never enforced.

## Authorization

Three independent mechanisms, all deny-by-default:

| Mechanism     | Decorator                             | Checks                                          |
| ------------- | ------------------------------------- | ----------------------------------------------- |
| Role          | `@Roles(Role.Admin, Role.SuperAdmin)` | `request.user.role`                             |
| Manager scope | `@ManagerOnly()`                      | `isManager`, plus every `/admin/` path by regex |
| Permission    | `@Permissions(Permission.UserWrite)`  | all named grants in `request.user.permissions`  |

- A plain `user` holds **zero** permissions, so a route naming one refuses.
- Grants live in `permissions` + `role_permissions`, seeded
  insert-only so a deploy never silently re-grants a removed permission.
- `PUT /admin/roles/:role/permissions` is the only supported way to change a
  grant, because it runs the cache invalidation the reads depend on.

**The JWT is not trusted for authorisation.** It carries `role` and `isManager`
and both are ignored — overwritten from the cached row. Otherwise demoting an
administrator would not take effect until the access token expired.

## Standards alignment

**This is a technical mapping, not a compliance claim.** HIPAA compliance is
determined by administrative and physical safeguards, policies, workforce
training, risk analysis and a Business Associate Agreement — none of which are
software and none of which this repository can supply. Nothing here makes a
deployment HIPAA compliant, and no row below should be quoted as evidence that
it is.

What this module does provide is a set of technical controls that map onto named
safeguards. Where a row is **partial** or **absent**, that is the accurate state
of the code.

### HIPAA Security Rule, 45 CFR 164.312 — Technical safeguards

| Safeguard                                     | Status      | Evidence                                                                                                                                   |
| --------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| §164.312(a)(2)(i) Unique user identification  | **met**     | `users.id` uuid; `sub` claim; every session and audit row attributes an actor                                                              |
| §164.312(a)(2)(iii) Automatic logoff          | **absent**  | no idle timeout and no absolute session cap — a chain refreshed before expiry never ends                                                   |
| §164.312(a)(2)(iv) Encryption and decryption  | **partial** | AES-256-GCM protects the TOTP secret only; `users.email` and all other identifiers are plaintext columns                                   |
| §164.312(a)(2)(ii) Emergency access procedure | **absent**  | no break-glass identity, no elevated role, no justification field, no time-box                                                             |
| §164.312(b) Audit controls                    | **partial** | see [audit](../audit/README.md) — rows are written, but append-only is convention only: no DB trigger, no hash chain, and no read surface  |
| §164.312(c)(1) Integrity                      | **partial** | the TOTP auth tag fails loudly on tamper; the password hash uses `timingSafeEqual`; nothing else is integrity-checked                      |
| §164.312(d) Person or entity authentication   | **met**     | password + optional TOTP, with lockout, replay rejection and enumeration resistance                                                        |
| §164.312(e)(1) Transmission security          | **partial** | HSTS and a bearer-only API are code; TLS termination, certificate management and encryption in transit of mail sit outside this repository |

Administrative safeguards §164.308 are out of scope for a module: risk analysis
(§164.308(a)(1)), workforce authorisation (§164.308(a)(3)), training
(§164.308(a)(5)), incident procedures (§164.308(a)(6)) and contingency planning
(§164.308(a)(7)) are organisational.

### ISO/IEC 27001:2022

| Control                                                            | Status      | Evidence                                                                                  |
| ------------------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------- |
| A.5.15 Access control                                              | **met**     | deny-by-default RBAC + permissions, scopes enforced per request                           |
| A.5.17 Authentication information                                  | **partial** | scrypt, policy, reuse history present; an admin-created account bypasses the policy check |
| A.5.25 Assessment and decision on event authentication information | **met**     | lockout, per-account and per-device revocation                                            |
| A.8.5 Secure authentication                                        | **met**     | second factor, rotation, reuse detection                                                  |
| A.8.16 Monitoring activities                                       | **partial** | audit rows written for privileged writes; no alerting on auth events beyond mail          |
| A.8.24 Use of cryptography                                         | **partial** | AES-256-GCM for one field, keyed by scrypt; nothing else at rest is encrypted             |
| A.8.5 Secure authentication — session management                   | **partial** | no idle or absolute timeout                                                               |

### OWASP ASVS 4.0.3 (selected)

| Requirement             | Status      | Evidence                                                                                             |
| ----------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| V2 Authentication       | **met**     |                                                                                                      |
| V3 Session management   | **partial** | rotation and revocation met; idle timeout and re-authentication absent                               |
| V4 Access control       | **met**     |                                                                                                      |
| V8 Data protection      | **partial** | redaction list covers credentials; see [audit](../audit/README.md) for the columns it does not cover |
| V12 Files and resources | n/a         | no upload endpoint                                                                                   |

### What a real deployment still has to add

None of these are code problems, and none are solvable inside this module:

- A **Business Associate Agreement** with every vendor that touches ePHI.
- TLS termination, certificate rotation, mTLS for service-to-service.
- **Backup and restore** with a rehearsed RPO/RTO. This repository ships none —
  `SECURITY.md` says to do it before the first deploy.
- Centralised, immutable, off-host audit storage. The trail here lives in the
  same database as the data it describes.
- Access reviews, joiner/mover/leaver process, periodic risk analysis.

## Gaps that a standards audit will find

Written down because a document that lists only strengths is marketing. Each is
a real gap in the code as it stands, with the file that proves it.

| #   | Gap                                                                                                                                             | Where                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1   | No idle timeout and no absolute session lifetime                                                                                                | `refresh-token.entity.ts`    |
| 2   | scrypt cost parameters are neither configurable nor stored per hash — a non-PHC `salt:hex` format, so cost cannot be raised without a migration | `password.util.ts`           |
| 3   | Reuse detection fires only for tokens revoked with reason `Rotated`                                                                             | `auth.service.ts` `rotate()` |
| 4   | Weak controls are off by default: `PASSWORD_CHECK_BREACH_LIST=false`, zxcvbn not a dependency                                                   | `password-policy.config.ts`  |

These are ordered by how much they cost an operator who inherits the
repository. The two that were fixed are gone from the list rather than ticked
off, because a table of things that are fine is noise in a document whose only
job is the things that are not.

## Where to go next

- [README.md](README.md) — the reasoning behind every decision above.
- [../users/README.md](../users/README.md) — the user domain and its export.
- [../audit/README.md](../audit/README.md) — what is recorded, and what is not.
- [../../core/logger/README.md](../../core/logger/README.md) — redaction in production logs.
