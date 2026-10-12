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

> Symptom: `queue_backlog` climbing, `job_lag_seconds` rising, `/health/ready`
> reporting the `queue` indicator as `degraded`.

### Which queue, and which driver

```bash
curl -s localhost:3000/api/v1/health/ready | jq '.info.queue'
```

```json
{
  "status": "degraded",
  "driver": "in-process",
  "reachable": true,
  "backlog": 1420,
  "worstQueue": "mail",
  "deadLettered": 0,
  "depths": {
    "mail": { "waiting": 1420, "active": 3, "failed": 0, "delayed": 0 }
  }
}
```

**Read `driver` first.** With `in-process`, the backlog is **this process's heap**:
a restart loses every pending job, and nothing else sees it. With `bullmq`, the
backlog is in redis and a restart loses nothing — but a redis outage means the
backlog is _unknown_, which is why an unreadable depth reports `degraded` rather
than a reassuring zero.

### Is it producing or consuming?

```promql
# How fast work is arriving
sum(rate(queue_backlog[10m]))

# How long the oldest work has waited
histogram_quantile(0.95, sum by (le, queue) (rate(job_lag_seconds_bucket[10m])))
```

Arrivals outpacing the workers means **producing**, which is a capacity problem.
Arrivals normal with the backlog flat means the queue is healthy and you are looking
at normal variation.

### The three causes

| Symptom                                    | Cause                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `driver: in-process`, backlog near the cap | Heap pressure. `QUEUE_IN_PROCESS_CONCURRENCY` is the per-queue worker limit. |
| `driver: bullmq`, `reachable: false`       | Redis is down. Workers cannot pull.                                          |
| `driver: bullmq`, reachable, backlog high  | A provider is slow, so each worker is occupied waiting.                      |

**The in-process backlog being full logs an error and drops the job** — refusing is
better than growing, because that list is heap and a traffic spike that outruns the
provider would otherwise take the process down. Those drops are in the log, not in
the queue.

### What to do

1. **Provider slow** — check `MailFailing` first. A queue full of waiting jobs
   behind a slow provider is the _same_ incident seen from the other side, and fixing
   the provider fixes both alerts.
2. **Redis down** — see [Redis has been lost](#redis-has-been-lost).
3. **Genuinely too much traffic** — enable the real queue:
   `npm install @nestjs/bullmq bullmq` and `QUEUE_ENABLED=true`. The in-process
   dispatcher is a fallback, not a queue.

**Nothing here takes the application down.** Requests are answered throughout;
outbound work is what is delayed. That is why the health check reports `degraded`.

---

## Redis has been lost

> Symptom: `CacheHealthIndicator` reporting `degraded`, `queue.reachable: false`,
> rate limiting letting everything through, the login lockout stopping counting.

Redis is the cache, the throttle counters, the login lockout, the session-revocation
record and — with BullMQ — the job backlog. Losing it does **not** stop the
application answering requests. It removes four protections at once, which is why
this reads as "things got slightly less secure" rather than "everything is down".

### What each thing does without it

| Subsystem      | Behaviour without redis                         | Risk                    |
| -------------- | ----------------------------------------------- | ----------------------- |
| Auth cache     | every request queries the database              | slower, not less secure |
| Rate limiting  | **nothing is limited**                          | brute force is possible |
| Login lockout  | **failures are not counted**                    | guessing is unlimited   |
| Session revoke | a revoked session revokes nothing until TTL     | logout does not take    |
| Job queue      | the in-process dispatcher runs, or nothing runs | pending work is lost    |

**The second and third are the dangerous ones**, and both are permanent until redis
returns — nothing degrades them, they are simply absent. Put a rate limit in front
of the application; these are the inner layer, not the only one.

### Diagnosing

```bash
redis-cli PING                    # connection
redis-cli INFO memory | grep used_memory_human
redis-cli INFO persistence        # loading:1 means loading a large RDB
docker logs redis 2>&1 | tail -50
```

`loading:1` for more than a minute is a server restoring a dataset larger than it
should have. It accepts connections and does not answer them.

### Recovering

1. **Check the dataset size.** An unexpectedly large `dump.rdb` usually means keys
   with a ttl that was never set. Compare against `used_memory` before and after a
   restart.
2. **Do not flush to "fix" it.** `FLUSHALL` discards the session-revocation records,
   so a logout performed during the outage stops working. Restore the data instead.
3. **After recovery, verify the things that were off.** `redis-cli DBSIZE` is a
   start; the real check is that rate limiting rejects the next oversized burst.

### What is _not_ affected

The auth cache falling back to the database is **slower, not less secure** — the
strategy still reads the row, and a deactivated account still stops working
immediately. The rate limiter and the login lockout are the exceptions, and both
fail open by design rather than by accident.

---

## Tracing a missing email

> Symptom: a user says they asked for a reset, a verification or an unlock link
> and nothing arrived.

This is what `mail_logs.requestId` exists for. The user's request has an id in
their client logs, and that id finds every attempt.

### Start from the request

If the user can supply the `X-Request-Id` their client received:

```sql
SELECT "createdAt", "template", "transport", "delivered", "statusCode",
       "permanent", "error", "attempts"
FROM mail_logs
WHERE "requestId" = $1
ORDER BY "createdAt";
```

More than one row means it was retried, and the sequence tells you which kind of
failure this was:

| `attempts` and `delivered`             | What happened                                                           |
| -------------------------------------- | ----------------------------------------------------------------------- |
| 1, `delivered: true`                   | It was sent. The problem is downstream — spam, or the address is wrong. |
| several, all false, `permanent: false` | Transient. The provider was unreachable.                                |
| several, all false, `permanent: true`  | Misconfigured. Nothing will retry it.                                   |
| **no rows at all**                     | It was never sent. Go to the next section.                              |

### Without the request id

Search by recipient, wide enough to be useful:

```sql
SELECT "createdAt", "template", "delivered", "statusCode", "error"
FROM mail_logs
WHERE "to" = $1 AND "createdAt" > now() - interval '1 day'
ORDER BY "createdAt" DESC;
```

### No rows at all

The send never happened. Three places, in order of likelihood:

1. **The queue backlogged.** Check `/health/ready` → `info.queue.backlog`. A
   verification mail queued behind a thousand others has not been sent yet; it is
   waiting. See [the queue is backed up](#the-queue-is-backed-up).
2. **The address is wrong.** `mail_logs.to` is what was _asked for_. If the user
   typed a different address, there is a row for the address they typed — and no row
   for the one they expected.
3. **It was never enqueued.** A failed `sendNotification` logs and swallows, by
   design, so the request still succeeds. Look for the `mailId` in the application
   log for that `requestId`.

### Then follow it into the log

Every line about a send carries the same id:

```bash
docker logs app 2>&1 | grep 'req-e3b0c442' | jq -r '[.timestamp, .level, .message] | @tsv'
```

`[mail:<mailId>] template=… transport=… accepted=… rejected=…` — and `mailId` is the
column on every row above, so the log line and the table join.

### If it was delivered and still did not arrive

The table has said everything the application knows. Past that point the answer is
in the mail provider's own logs, keyed on the recipient and the send time — and the
two most common answers are a spam folder and an address that does not exist,
which the provider reports as a deferred bounce, sometimes hours later.
