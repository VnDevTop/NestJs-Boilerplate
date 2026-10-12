# Metrics

Prometheus counters and gauges, or nothing at all when the package is absent.

```text
GET /api/v1/metrics
```

## The absence of metrics is not an error

`loadOptional` returns `null`, every method returns without doing anything, and the
application runs exactly as it did before — just without a `/metrics` endpoint.
That is the same rule every other optional feature here follows, and the reason is
the same: the alternative is a package that is not installed being a build failure
or a boot failure, which turns a missing convenience into a missing application.

**`/metrics` answers 404 rather than an empty body.** A 200 with no metrics reads
as "this application has no jobs and no mail" — a dashboard showing a healthy idle
system. That is the exact failure the missing case creates for anyone watching it.
A 404 is unambiguous.

**There is no health indicator for metrics on purpose.** A deployment that has not
installed `prom-client` is not broken, and reporting it as degraded would page
somebody about a feature nobody asked for. `curl /metrics` returning 404 is the way
to find out.

## What is recorded

| Metric                         | Type      | Labels                               |
| ------------------------------ | --------- | ------------------------------------ |
| `mail_sent_total`              | counter   | `template`, `transport`              |
| `mail_failures_total`          | counter   | `template`, `transport`, `permanent` |
| `notification_sent_total`      | counter   | `event`, `channel`, `delivered`      |
| `retention_rows_deleted_total` | counter   | `target`                             |
| `job_lag_seconds`              | histogram | `queue`, `job`                       |
| `queue_backlog`                | gauge     | `queue`                              |
| `dead_lettered_total`          | gauge     | —                                    |
| `maintenance_age_hours`        | gauge     | —                                    |

**Counts are taken where the outcome is known, not where the work was accepted.**
`mail_sent_total` is incremented after the provider answers, not on enqueue: a
provider that refuses everything produces a healthy-looking send count forever.

**`permanent` is a label rather than a second metric.** A 4xx and a timeout are
different incidents and "are these transient" needs them split — but they are not
additive, so they are one series with a label, not two counters.

**`retention_rows_deleted_total` is per target.** "The job deleted a million rows"
is not answerable by an alert; "notification_logs is not being pruned" is.

## Labels are bounded, on purpose

`template`, `transport`, `event`, `channel`, `queue`, `job` — all from a fixed
enumeration. `email` is not on any of them, and it is not an oversight: one series
per address is a cardinality bomb that presents as a slow crawl, and it would put
every address in a metrics store with a different retention policy to the
database.

## `job_lag_seconds`

Seconds between a job being accepted and a worker picking it up, read from what
each driver already knows:

- **BullMQ** — `processedOn - timestamp` on the job bullmq hands the worker.
- **in-process** — a stamp on the pending entry, measured before the processor
  runs.

BullMQ's own fields rather than a stamp of ours is what makes the number comparable
across a deployment that switches drivers: the same question, answered from
whichever side has the data.

**Measured before the work, not after.** A slow processor would otherwise be
counted as queue lag, which is the one thing this metric must not measure.

**Clamped at zero.** A clock that jumps backwards, or a redelivery whose
`processedOn` predates its `timestamp`, produces a negative observation. A
histogram bucket below zero silently corrupts every quantile computed over it, for
the life of the process — one token against a pipeline that is wrong forever.

Buckets are for seconds: sub-second is normal, ten minutes is an incident, and an
alert on `histogram_quantile` wants to sit on the log-friendly boundary between.

## The registry is ours

`prom-client`'s default registry is process-global, which makes it impossible to
reset between tests and leaks state between test files in the same process. Owning
it is what makes `clear()` exist, and what makes the metrics deterministic.

`prom-client` has no reset-everything on the registry — each metric resets itself —
so the created metrics are kept in a list rather than the registry being poked at
through an untyped cast. Poking and hoping is code that silently does nothing.
