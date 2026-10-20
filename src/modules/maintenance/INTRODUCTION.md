# Maintenance — Introduction

Nightly retention: deleting rows past their age, in batches, with a rehearsal
mode and a record of every run.

The detailed reference is [README.md](README.md).

## Ten retention targets

| Target                      | Table                       | Deletes when                            | Env var                                 | Default |
| --------------------------- | --------------------------- | --------------------------------------- | --------------------------------------- | ------- |
| `users`                     | `users`                     | soft-deleted before cutoff              | `RETENTION_USERS_DAYS`                  | 30      |
| `email-verification-tokens` | `email_verification_tokens` | expired                                 | `RETENTION_EMAIL_TOKENS_DAYS`           | 7       |
| `password-reset-tokens`     | `password_reset_tokens`     | used or expired                         | `RETENTION_RESET_TOKENS_DAYS`           | 7       |
| `refresh-tokens`            | `refresh_tokens`            | revoked or expired                      | `RETENTION_REFRESH_TOKENS_DAYS`         | 7       |
| `notification-logs`         | `notification_logs`         | older than cutoff                       | `RETENTION_NOTIFICATION_LOGS_DAYS`      | 30      |
| `mail-logs`                 | `mail_logs`                 | older than cutoff                       | `RETENTION_MAIL_LOGS_DAYS`              | 30      |
| `mail-template-versions`    | `mail_template_versions`    | older than cutoff                       | `RETENTION_MAIL_TEMPLATE_VERSIONS_DAYS` | 365     |
| `audit-logs`                | `audit_logs`                | older than cutoff                       | `RETENTION_AUDIT_LOGS_DAYS`             | 365     |
| `account-unlock-tokens`     | `account_unlock_tokens`     | used or expired                         | _(reuses `_RESET_TOKENS_DAYS`)_         | 7       |
| `user-devices`              | `user_devices`              | no live refresh token — **immediately** | —                                       | —       |

The `users` row cascades in the database to six child tables. Those are reported
but not counted separately, so the next run does not double-count them.

**The age floor is 1 day and it is enforced twice** — by Zod validation and again
at the point of use, because a config object assembled in a test must not be
able to delete today's data.

## Batching

| Setting               | Env var                 | Default      |
| --------------------- | ----------------------- | ------------ |
| Rows per `DELETE`     | `RETENTION_BATCH_SIZE`  | 5 000        |
| Pause between batches | `RETENTION_BATCH_DELAY` | 100 ms       |
| Run deadline          | `RETENTION_RUN_TIMEOUT` | 3 600 000 ms |

One transaction per batch, so a failure rolls back that batch only — and the
rollback is itself guarded so it cannot mask the real error. The deadline is
checked _before_ each batch and the run **stops rather than finishing the batch
in progress**.

Table names come from the policy file, never from a request, and are quoted
rather than interpolated raw.

## Dry run

`RETENTION_DRY_RUN=true` globally, or `POST /admin/retention/dry-run` for one
run. Per target it counts exactly — `SELECT count(*)`, no cap — and deletes
nothing. The dry run **is itself recorded** in `maintenance_logs`, and the
response is built from the written row so the id is real.

It proves the predicate matches and how many rows would go. It does **not** prove
the `DELETE` works.

## Run history

`maintenance_logs` holds start, finish, duration, `dryRun`, `totalDeleted`,
`timedOut`, `cancelled`, `trigger` (`cron` | `manual` | `admin`), `pending[]`,
`failedTargets[]` and the full per-target result. `record()` **throws** on
failure — the deliberate exception to this repository's fail-open rule, because a
retention run nobody knows happened is worse than a failed one.

`RetentionTrigger.Manual` is defined and never written.

## Watching and stopping a run

A queued run is a job with an id. `GET /jobs/:id` reports how many targets are
done, how many there are and which one is in flight; `POST /jobs/:id/cancel` asks
the run to stop.

The count is of **targets**, not of rows: the number of rows is not known until
they are counted, and counting them would mean scanning every table twice.

The cancellation is checked **between batches**, never inside one. Each batch is
its own transaction, so stopping between two of them leaves the table in a state
an interrupted run would also leave, and stopping inside one would leave a
half-deleted table nobody asked for.

A cancelled run is recorded with `cancelled: true` and the targets it did not
reach in `pending`. It is not a timeout and not a success: the tables it missed
are the next run's work rather than a fault, and the two are separate columns
because `pending` alone cannot tell them apart.

## Controls

- Hard age floor at the point of deletion, not only in config validation.
- Cascades are database-level, so a half-deleted user's children cannot survive.
- `account_unlock_tokens` cascades with the user — a restored account cannot
  inherit unlock links mailed to whoever locked it.
- Per-target Prometheus counters, so "notification_logs is not being pruned" is
  alertable rather than noticed months later.
- Anomaly notification on timeout or failed target.

## Standards alignment

Not a compliance claim — see [../auth/INTRODUCTION.md](../auth/INTRODUCTION.md).
Retention is the mechanism most of the privacy guarantees rest on, because
storage limitation is not a promise you can keep indefinitely.

| Requirement                                               | Status          | Notes                                                                                                                  |
| --------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GDPR Art. 5(1)(e) Storage limitation                      | **implemented** | 10 tables with configured ages and defaults                                                                            |
| GDPR Art. 17 — erasure                                    | **partial**     | the user row is purged; `audit_logs`, `mail_logs` and `notification_logs` carry no FK and survive to their own windows |
| HIPAA §164.308(a)(1)(ii)(C) Termination procedures        | **partial**     | `users` cascades correctly; the four log tables have no user link to cascade                                           |
| HIPAA §164.316(b)(2)(i) Documentation retention — 6 years | **not met**     | `audit_logs` prunes at **365 days**. A HIPAA deployment must set `RETENTION_AUDIT_LOGS_DAYS` to at least 2190          |
| ISO 27001 A.8.10 Information deletion                     | **implemented** |                                                                                                                        |
| ISO 27001 A.8.15 Logging — retention aligned to policy    | **partial**     | run history is never pruned at all                                                                                     |

The 365-day default for audit logs is worth pausing on. It is a reasonable
default for a general-purpose template, and it is **shorter than several
regulated industries require**. Set it explicitly rather than inheriting it.

## Known gaps

| #   | Gap                                                                                                                                                 | Where                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1   | **`maintenance_logs` is never pruned** — trim it by hand, quarterly                                                                                 | `maintenance-log.entity.ts`     |
| 2   | `RETENTION_MAIL_TEMPLATE_VERSIONS_DAYS` has **no Zod validation** — the only age without it                                                         | `env.validation.ts`             |
| 3   | A missed run is never caught up — restart re-registers, but a night the process was down at the scheduled minute is skipped silently                | `retention.scheduler.ts`        |
| 4   | Multiple instances run against the same rows with no lock or claim table. Safe, because only already-expired rows are touched, but it costs latency | `retention.service.ts`          |
| 5   | An in-process enqueued job is lost on restart                                                                                                       | `queue/README.md`               |
| 6   | `user_devices` deletion discards `ipAddress` and `userAgent` of past logins along with the row                                                      | `retention.policy.ts`           |
| 7   | The run is not transactional across targets, by design — a failed target does not stop the rest                                                     | `retention.service.ts`          |
| 8   | Retention execution writes **no audit row**, and neither does the admin route that triggers it                                                      | `admin/retention.controller.ts` |
| 9   | `types/env.d.ts` says retention is "off by default"; the code default is **on**                                                                     | `retention.config.ts`           |
| 10  | `RETENTION_LOGIN_ATTEMPTS_DAYS` is accepted and does nothing — the target is deferred                                                               | `retention.policy.ts`           |

## Where to go next

- [README.md](README.md) — design and failure behaviour.
- [../audit/INTRODUCTION.md](../audit/INTRODUCTION.md) — what retention deletes.
- [../../docs/runbook.md](../../../docs/runbook.md) — what to do when a run stops.
