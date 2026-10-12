# Health

Liveness, readiness and the shutdown flag that connects them.

```text
GET /api/v1/health/live     liveness, touches nothing external
GET /api/v1/health/ready    database, cache, mail, queue, maintenance
GET /api/v1/health          the same as ready
```

## Liveness and readiness are separate on purpose

Liveness must stay green while a dependency is down. A failing liveness probe
makes an orchestrator restart every healthy instance at exactly the moment the
database is having trouble, which turns one outage into a cluster-wide restart
loop.

Readiness is the one that goes red, so the load balancer sends traffic elsewhere
without anything being restarted.

All three are `@Public()`. A probe has no token, and a health endpoint that
depends on the auth system is a health endpoint that fails when auth is down.

## The cache check is a round trip

```ts
await this.cacheService.set(key, token, { ttl: 60 });
const value = await this.cacheService.get<string>(key);

return value === token ? up : degraded;
```

A plain read would report a dead cache as healthy. cache-manager turns a failing
store into a miss, so "unreachable" and "empty" are indistinguishable through a
read. Writing a value only this check knows and comparing it on the way back is
what separates them.

## A broken cache is degraded, not down

There is no `down` here, and that is the design rather than an omission.

Everything downstream of redis in this application fails open: rate limiting lets
requests through, the login lockout stops counting, and the auth cache falls back
to a database query. The service keeps serving traffic throughout, more slowly.

Terminus treats `down` as a failure and throws 503. An orchestrator reading that
would pull every instance out of rotation over a redis problem, so a cache
outage would become an outage of a system that was still answering requests.
`degraded` is a status terminus understands: the entry lands in `info`, the
aggregate response says `degraded`, and the request returns **200**.

So an operator sees it in the body and in alerting, and nothing is restarted. If a
deployment genuinely cannot serve without its cache, the correct answer is to stop
failing open there — not to make the probe report a failure the application is not
having.

This is the same trap that made `CacheService.isHealthy()` impossible, which is
why that method does not exist.

## Shutdown

`ShutdownService` exposes `isShuttingDown`, flipped by the first shutdown signal.
`/health/ready` reports not ready from then on, so the instance drains before its
connections close. `app.enableShutdownHooks()` in `src/main.ts` is what lets SIGTERM
reach the process; `docker-compose.yml` gives it 30 seconds.

## Nothing here is ever `down`

Every indicator reports `degraded` rather than `down`, and that is the design
rather than an omission.

`down` makes Terminus throw 503. An orchestrator reading that takes every instance
out of rotation. So each of these would turn a _partial_ failure into a full
outage of a system that was still answering requests:

| Broken            | What still works                                           |
| ----------------- | ---------------------------------------------------------- |
| Redis             | everything, via the fallbacks; slower                      |
| The mail provider | registrations and resets; mail arrives later or not at all |
| The queue backlog | every request; queued work arrives later                   |
| BullMQ's store    | the in-process fallback, if it is enabled                  |

The one thing that _is_ allowed to go red is the database, on readiness, because
nothing works without it.

## The mail check never sends anything

There is no recipient who wants a probe email, no way to keep a probe address out
of a real recipient list, and a provider rate limit would eventually refuse the
probe and take the real queue down with it. So the check reports **which transport
is configured** and, when the transport offers one, calls its own `verify()` —
nodemailer's, which speaks EHLO and closes without consuming a quota.

What it reports honestly is the transport name, because "why did nobody get the
mail" very often starts with "this deployment has no transport at all". A
`memory` transport in production is reported `degraded` on its own: every mail is
buffered in a buffer that dies with the process, and the name alone reads like a
configuration choice rather than a finding.

A transport with no `verify()` reports `up, verified: false`. That is a gap, not a
failure, and shipping a probe to close it would mean sending mail.

## The queue check

```json
{
  "queue": {
    "status": "degraded",
    "driver": "bullmq",
    "reachable": true,
    "backlog": 5_000,
    "worstQueue": "mail",
    "deadLettered": 3,
    "depths": {
      "mail": { "waiting": 5000, "active": 2, "failed": 3, "delayed": 0 }
    },
    "reasons": ["the mail backlog is 5000, above 1000"]
  }
}
```

**Backlog per queue, and the worst one named.** The config gives each queue its
own concurrency, and mail being slow is not maintenance being slow.

**`driver` is first because the same symptom needs different answers.** A
deployment with `QUEUE_ENABLED=false` has no shared backlog at all: every pending
job dies with the process, and a restart loses whatever was waiting.

**An unreadable backlog is `degraded`, never `up`.** Zero waiting jobs because the
store is unreachable looks healthier than an application with no jobs at all, and
that is the exact moment an operator most wants to be told. This is why
`JobQueue.depth()` returns `null` rather than zeroes when it cannot answer.

**`deadLettered` is separate from `backlog`** because a queue full of failures and
a queue full of undelivered mail are two different incidents, and an alert that
cannot tell them apart pages somebody for the wrong one.

**The threshold is a constant, not a setting.** A backlog limit is a statement
about what this application can absorb, not a property of the deployment. A
deployment that needs a different one should be told, not handed a knob that
quietly disables the alert.

## The maintenance check

```json
{
  "maintenance": {
    "status": "degraded",
    "finishedAt": "2026-03-01T03:19:02.000Z",
    "ageHours": 27,
    "deleted": 0,
    "timedOut": false,
    "dryRun": false,
    "failedTargets": [],
    "late": true,
    "reason": "no run has finished in 27 hours"
  }
}
```

**This is the only signal that a missed retention job exists.** Nothing fails,
nothing errors, and every request answers — the tables the policy prunes just keep
growing until one of them is large enough that something else breaks, and by then
the cause is days old with nothing recorded it.

**26 hours** is the plan's threshold and it is chosen: the job runs at 03:17
daily, so that is one full cycle missed plus most of the next. Shorter would fire
on a run that was merely late because the scheduler was restarting; longer would
let a nightly job stay broken over a weekend.

**It reports the _last_ run, not the last successful one.** A failed run is still
the most recent thing that happened, and it is the more useful answer — the
question is usually "did it run", and a run that failed while deleting nothing is
worse to hide than to show.

**`dryRun` is in the payload** because a green run that deleted nothing is not the
same as a green run that had nothing to delete. An operator reading `deleted: 0`
on the job whose whole purpose is deleting needs to tell those apart.

**`reason` is omitted when there is nothing wrong.** A key that is always
populated is a key that stops being read.

**It never blocks readiness**, and neither does anything else here. A housekeeping
failure is not a reason to pull every instance out of rotation.
