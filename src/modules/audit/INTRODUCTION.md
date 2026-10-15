# Audit — Introduction

The record of privileged actions. This module is what an investigator, an
auditor or an incident responder reads, so its limits matter as much as its
contents.

The detailed reference is [README.md](README.md).

## What it records

One row per privileged action, written by an interceptor bound per controller —
not globally, because most routes are not worth a row.

| Field                                | Purpose                                                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `actorId`, `actorEmail`, `actorType` | who — `user`, `system` or `anonymous`. Email is a **snapshot**, not a join, so it still reads correctly after the account is gone |
| `action`                             | `entity.action`, e.g. `users.update`                                                                                              |
| `targetType`, `targetId`             | what — a string, not a uuid, so sessions and role names fit                                                                       |
| `after`, `changedFields`             | the response, redacted, plus the sorted set of keys that differ                                                                   |
| `before`                             | **always `null`** on interceptor entries — see below                                                                              |
| `ipAddress`, `userAgent`             | where from, both length-capped                                                                                                    |
| `requestId`                          | correlates the row to logs and to a mail delivery                                                                                 |
| `outcome`, `statusCode`, `error`     | `success`/`failure`, the real status rather than a guessed 500                                                                    |
| `createdAt`                          | indexed                                                                                                                           |

## What is audited

Six actions, enforced by `audit-policy.spec.ts` against real handler metadata:

| Action                      | Route                                |
| --------------------------- | ------------------------------------ |
| `users.create`              | `POST /users`                        |
| `users.update`              | `PATCH /users/:id`                   |
| `users.delete`              | `DELETE /users/:id`                  |
| `roles.permissions.replace` | `PUT /admin/roles/:role/permissions` |
| `templates.mail.update`     | `PUT /admin/mail-templates/:name`    |
| `templates.mail.reset`      | `DELETE /admin/mail-templates/:name` |

Read routes are deliberately **not** audited, and the spec asserts that — so
"no rows" for a `GET` is intended rather than a gap.

## Three properties worth knowing

**`before` is always null.** The interceptor snapshots the _response_, so the
table records what a write produced, never what it replaced. A route that knows
the prior state must call `AuditService.record` directly — and **no service in
this repository does**. Reconstructing "what was there before the change" from
the trail alone is not possible.

**Failures are recorded too.** The interceptor uses `catchError`, records the
failure, and rethrows the original error. A refused authorisation attempt on an
audited route leaves a row.

**`record()` never throws.** An outage in the audit writer costs a logged gap
rather than a failed request. That is a deliberate trade: an outage in the log
must not become an outage in the product. It also means the trail can have holes
during exactly the incident you want it for.

## Redaction

`before` and `after` pass through `redactValue` with the shared 34-key list in
[../../core/redact](../../core/redact). A `password`, `token`, `secret`,
`recoveryCodes` or `authorization` key is replaced with `[redacted]` before the
row is written, with depth and cycle caps so a hostile body cannot overflow.

`error` goes through the text redactor before it is clipped — the reverse order
would keep the first 500 characters, which is exactly where a token in a query
string sits. `actorEmail`, `ipAddress` and `userAgent` are stored as-is: they are
personal data by definition, and a redactor that removed them would make the trail
useless for the incident it exists for.

## Standards alignment

Not a compliance claim — see [../auth/INTRODUCTION.md](../auth/INTRODUCTION.md).
Audit controls are one HIPAA technical safeguard, and three of the properties a
regulator asks for are not met here.

| Requirement                                                     | Status      | Notes                                                                                           |
| --------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------- |
| HIPAA §164.312(b) Audit controls                                | **partial** | rows are written with actor, time, action and outcome — but see the table below                 |
| HIPAA §164.308(a)(1)(ii)(D) Information system activity review  | **partial** | retention prunes at `RETENTION_AUDIT_LOGS_DAYS` (default 365); no periodic review process ships |
| HIPAA §164.308(a)(5)(ii)(A) Security awareness — log monitoring | **partial** | no alert fires on the audit stream itself                                                       |
| ISO 27001 A.8.15 Logging                                        | **partial** |                                                                                                 |
| ISO 27001 A.8.16 Monitoring activities                          | **partial** |                                                                                                 |
| SOC 2 CC7.2 — monitoring for anomalies                          | **not met** | no read surface, see below                                                                      |

### Why "partial" three times

| Missing property             | What it means in practice                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No tamper-evidence**       | Append-only is a _convention_. There is no database trigger, no hash chain, no signature. An operator with SQL can `UPDATE` or `DELETE` rows undetectably. The entity docblock says so explicitly |
| **No read surface**          | There is no admin route for the trail. Answering "show me every `users.update` on this account" means leaving the application and writing SQL                                                     |
| **Same host, same database** | The trail lives beside the data it describes, so an attacker who reaches the database reaches both, and a restore rewinds both                                                                    |

A regulator asking "prove the log was not altered" gets no answer this code can
give. Centralised, append-only, off-host storage is the fix, and it is
infrastructure rather than application code.

## Known gaps

| #   | Gap                                                                                                                                                                    | Where                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | **No tamper-evidence of any kind** — no trigger, no hash chain                                                                                                         | `1791800000000-AddAuditLogs.ts`    |
| 2   | **No admin route to read the trail**                                                                                                                                   | `audit/README.md`                  |
| 3   | `before` is always null, so prior state is unrecoverable from the trail                                                                                                | `audit.interceptor.ts`             |
| 4   | `POST /admin/retention/run` and `/dry-run` are unaudited — the two routes that can hard-delete every user row record only `trigger='admin'`, which carries no actor id | `admin/retention.controller.ts`    |
| 5   | Retention execution is not itself audited                                                                                                                              | `maintenance/retention.service.ts` |

Gap 1 and gap 2 are what a regulator means by audit controls, and neither is a
library question. Tamper-evidence wants an append-only store the application
does not own, and a read surface is a permission decision with a retention
question behind it. Both are listed here because the absence is the finding.

## Where to go next

- [README.md](README.md) — the design and the reasoning.
- [../maintenance/INTRODUCTION.md](../maintenance/INTRODUCTION.md) — when rows
  are deleted.
- [../../core/redact](../../core/redact) — the key list.
