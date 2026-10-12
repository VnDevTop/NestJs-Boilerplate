# Runbook

What to check when an alert fires, and what to do about it.

Each section is named for the alert that links to it, so the link in a
notification lands here. Nothing in this file should ever need a deployment to
open the source to answer.

---

## Mail is failing

> Alert: `MailFailing` — a large share of outbound mail is being refused or
> failing. Waits 5 minutes over a 5-minute average, fires above 10%.

This is the one a customer has usually noticed. Password resets and address
verification both stop working.

### Is it the provider or us?

```sql
SELECT "createdAt", "template", "statusCode", "error"
FROM mail_logs
WHERE "delivered" = false
ORDER BY "createdAt" DESC
LIMIT 20;
```

The `statusCode` column is the fastest discriminator:

| What you see                           | What it means                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `401` or `403`                         | Credentials. `MAIL_USERNAME` / password is wrong or revoked.                                           |
| `429`                                  | Rate limited. Slow down, or move to another provider.                                                  |
| `4xx`, any other                       | Permanent. Retrying will be refused the same way — see the `permanent` label on `mail_failures_total`. |
| `5xx` or a timeout                     | The provider is degraded. Retries are already running.                                                 |
| nothing, and `mail_sent_total` is flat | Nothing is being sent at all — the queue is the problem, not the provider.                             |

### The split by permanence

```promql
sum by (permanent) (rate(mail_failures_total[15m]))
```

`permanent="true"` means retrying is pointless and the fix is a credential or an
address. `permanent="false"` means it is worth waiting for.

### What to do

1. **401/403** — the credentials are wrong. Nothing is broken; mail has been
   silently going nowhere. Fix the environment and restart.
2. **429** — the provider is rate limiting. `MAIL_THROTTLE.perEmailPerHour` is 3
   and `perIpPerHour` is 10 by default; a deployment genuinely needing more should
   say so rather than have the limit raised by accident.
3. **5xx** — wait. The retry policy already has five attempts with exponential
   backoff. If it is still failing after 15 minutes, page the provider.
4. **No rows at all** — check the queue. See [the queue is backed up](#the-queue-is-backed-up).

**Nothing here takes the application down.** Mail failing degrades a signup into
one the owner finishes from their inbox and a reset into a wait. It does not stop
requests being answered, which is why the health check reports `degraded` rather
than `down`.

---

## Jobs are dead-lettering

> Alert: `JobsDeadLettered` — jobs have exhausted their retries and will not run
> again. Waits 1 hour.

A dead-lettered job is not going to retry. Whatever it was going to do has not
happened.

### What is in the list

```bash
redis-cli LRANGE "$(redis-cli --scan --pattern 'queue:dead-letter' | head -1)" 0 4
```

Each entry names the queue, the job, the attempt count and the error. Start with
the job name — `mail.send` and `notification.deliver` are the two that have
consequences a person can notice.

### Common causes

| Error in the entry          | Cause                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a `4xx` from the provider   | Permanent. The retry budget was spent on something that would fail the same way. The `permanent` flag exists for this and the policy does not retry it. |
| `ECONNREFUSED`, `ETIMEDOUT` | The provider was down for the whole window.                                                                                                             |
| a database error            | Usually a pool exhaustion during a retention run. Check `maintenance_age_hours`.                                                                        |

### Replaying

There is no replay endpoint. Read the entry, decide whether the work is still
wanted, and trigger it the way the original did:

- **mail** — resend through the application rather than the queue, so the retry is
  deduplicated against the mail log rather than producing a second copy.
- **notification** — usually not worth replaying. A stale security alert sent an
  hour late is noise, and the operator channel has usually moved on.

The dead-letter list is capped. Once it is full, new entries replace old ones —
which is why it is an alert and not a log to read after the fact.

---

## The retention job has not run

> Alert: `MaintenanceOverdue` — the nightly retention job has not finished in over
> 26 hours. Waits 5 minutes.

**This is the failure nobody notices.** Nothing errors, every request is answered,
and the tables the policy prunes just keep growing until one of them is large
enough that something else breaks — by which point the cause is days old.

### Is it late, or did it stop?

```bash
curl -s localhost:3000/api/v1/health/ready | jq '.info.maintenance'
```

```json
{
  "status": "degraded",
  "finishedAt": "2026-03-01T03:19:02.000Z",
  "ageHours": 31,
  "deleted": 18422,
  "failedTargets": [],
  "late": true,
  "reason": "no run has finished in 31 hours"
}
```

`lastRun: null` means it has **never** run, which is a different problem: either
the scheduler is not enabled or `RETENTION_ENABLED=false`.

### Why it did not run

1. **`RETENTION_ENABLED=false`** — deliberate, and nothing is broken. Turn it back
   on when you want it.
2. **The process is not running at 03:17** — a deployment that scales to zero
   overnight misses the window entirely. `RETENTION_SCHEDULE` moves it.
3. **It ran and timed out** — `timedOut: true` and `pending` lists the targets it
   never reached. `RETENTION_RUN_TIMEOUT` is 3,600,000 ms; a batch size of 5,000
   against a large table can exhaust it.
4. **It ran and a target failed** — `failedTargets` names them. The run continues
   past a failing target by design, so one broken target does not stop the others,
   and it is reported rather than hidden.

### Running it by hand

```bash
# Dry run first. This is the reason it exists.
curl -X POST localhost:3000/api/v1/admin/maintenance/retention/run \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"dryRun": true}'
```

Read the `targets` in the response. If the numbers look right, run it again with
`dryRun: false`.

**A dry run that has never been done is the reason the first real one is scary.**
The output is the same shape either way, so there is nothing to be surprised by
apart from the row counts.

---

## The queue is backed up

See [the queue is backed up](#the-queue-is-backed-up).
