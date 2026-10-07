# Maintenance

Housekeeping that runs on its own: deleting rows that can no longer be useful.

## What runs

A nightly job, at `RETENTION_SCHEDULE` by default, which deletes in batches and
records what it did. It is enqueued through the job queue rather than called
directly, so it shares one execution path with a manual run and does not need a
second implementation for the case where redis is down.

```text
Target                        Rule                                    Default
users (soft deleted)          hard delete after deletedAt + N days     30
email_verification_tokens     delete once expiresAt passed            +7 grace
password_reset_tokens         delete once used, or expiresAt + N      +7 grace
refresh_tokens                delete when revokedAt + N, or expired   7
user_devices                  delete when no live refresh token       immediate
```

`two_factor_secrets` has no rule of its own. It cascades with the user delete, so
a rule for it would be a second path to the same rows.

## Running it by hand

| Route                           | What it does                                       |
| ------------------------------- | -------------------------------------------------- |
| `POST /admin/retention/dry-run` | Counts what a run would delete and deletes nothing |
| `POST /admin/retention/run`     | Queues a real run and returns immediately          |
| `GET  /admin/retention/runs`    | The run history                                    |

A dry run is synchronous, because counting is fast enough to answer inside a
request and an operator rehearsing against production data wants the numbers now.
A real run is queued, because deleting in batches with a pause between them can
take minutes, which is longer than a request should stay open.

Both write routes need the `maintenance:run` permission, so a super administrator
rather than an administrator.

## Three decisions that shape the job

**Batched, one transaction each.** `DELETE ... WHERE id IN (SELECT id ... LIMIT n)`,
committed per batch with a pause between. One statement over a large table holds a
lock long enough to show up as latency to everything else.

**A failed target does not end the run.** Retention is housekeeping. One renamed
column should cost the operator a skipped table, not a week of uncollected data
across every table.

**The run stops on its timeout rather than finishing the batch in progress.** A
timeout here is nearly always a lost database connection rather than a full disk,
because rows are removed continuously, and a lost connection makes the remaining
batches pointless anyway.

## Rehearsing a first run

`RETENTION_DRY_RUN=true` reports what would be deleted and deletes nothing. It is
also what the admin dry-run route does regardless of the flag, so an operator can
rehearse without a configuration change and a restart.

The ages are all at least one day. A zero means "delete everything older than
now", which turns a typo in an environment variable into data loss, and the guard
is enforced at the point of use rather than only in environment validation,
because a config object assembled in a test must not be able to do it either.

## What is not collected

| Table                  | Why not                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `mail_logs`            | No log table yet; listed in `DEFERRED_TARGETS`                |
| `notification_logs`    | Same                                                          |
| Login attempt counting | In redis, with its own expiry                                 |
| `audit_logs`           | A later phase, and an audit trail kept for a month is not one |

They are named in code rather than left out, so the gap is reviewable instead of
forgotten. A rule naming a table that does not exist would fail on every run.

## Known limits

- **The schedule does not catch up a missed run.** Restarting the app is fine,
  because the schedule is re-registered on every boot and fires at the next
  occurrence, but a window in which the process is not running at
  `RETENTION_SCHEDULE` means that night is skipped and nothing logs an error.
- **With several instances each run sees the same rows**, so one night can produce
  several runs. Every run is idempotent and only touches rows already past their
  age, so this costs latency rather than correctness.
- **With the in-process dispatcher**, a job enqueued but not yet processed is lost
  on restart. With BullMQ it survives in redis, but the worker is created lazily on
  first use, so it waits for the next enqueue to be picked up.
- **Nothing prunes the run history.** A run is about 728 bytes, so a year of
  nightly runs is roughly 260 KB. The table carries no index for that reason and is
  trimmed by hand when the row count starts to matter.

## Configuration

| Variable                | Default      | What it does                                  |
| ----------------------- | ------------ | --------------------------------------------- |
| `RETENTION_ENABLED`     | `true`       | Whether the nightly job runs                  |
| `RETENTION_DRY_RUN`     | `false`      | Reports instead of deleting                   |
| `RETENTION_SCHEDULE`    | `17 3 * * *` | Off-peak minute, so it avoids other schedules |
| `RETENTION_BATCH_SIZE`  | `5000`       | Rows per delete statement                     |
| `RETENTION_BATCH_DELAY` | `100`        | Milliseconds between batches                  |
| `RETENTION_RUN_TIMEOUT` | `3600000`    | Milliseconds before a run gives up            |
| `RETENTION_*_DAYS`      | per table    | The age each target acts at                   |

A malformed `RETENTION_SCHEDULE` is logged and the job is not scheduled, rather
than throwing out of bootstrap. Refusing to boot over a typo in an environment
variable turns a housekeeping problem into an outage.
