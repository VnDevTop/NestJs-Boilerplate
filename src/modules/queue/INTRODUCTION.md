# Queue — Introduction

One `JobQueue` interface over two drivers, plus deduplication, a retry policy,
dead-lettering, idempotency keys and the progress of a running job. The
consistency rule worth knowing up front: **enabling BullMQ does not change the
attempt budget**, because both drivers read the same configuration.

The detailed reference is [README.md](README.md).

## Drivers

| `QUEUE_ENABLED`   | bullmq installed | Driver                                    |
| ----------------- | ---------------- | ----------------------------------------- |
| `true`            | yes              | `BullMqDispatcher`                        |
| `true`            | no               | `InProcessDispatcher` — logged at `error` |
| `false` (default) | either           | `InProcessDispatcher`                     |

Queues: `mail`, `notification`, `maintenance`, `digest`.

**Selection happens once, at boot.** There is no runtime failover: if BullMQ was
chosen and Redis dies afterwards, `enqueue` rejects. `README.md` describes the
in-process fallback as covering "when redis is unreachable during an incident"
— that is true of the boot-time condition (package missing, queue disabled) and
not of a live outage.

## Jobs have an id, and it is the handle

`enqueue` mints a uuid and returns it. `GET /jobs/:id` answers with the job's
status, how far it has got, the item in flight and when it started and finished.
`POST /jobs/:id/cancel` asks the job to stop.

| Route                   | Permission                      | Answers            |
| ----------------------- | ------------------------------- | ------------------ |
| `GET /jobs/:id`         | `job:read` (admin, super admin) | 200, 404, 503      |
| `POST /jobs/:id/cancel` | `job:cancel` (super admin only) | 202, 404, 409, 503 |

**A 404 and a 503 are different facts.** A missing job is a 404; a store that
cannot be reached is a 503. Answering "no such job" during a redis outage tells
an operator their job does not exist while it is running.

**Stopping is a flag, not a kill.** The job checks at a boundary it knows is
safe — for the retention run, between batches, each of which is its own
transaction — and stops there. A cancelled job is not retried, not dead-lettered,
and its deduplication key is released.

## Retry policy

| Setting                        | Env var                 | Default   |
| ------------------------------ | ----------------------- | --------- |
| Attempts (including the first) | `QUEUE_RETRY_ATTEMPTS`  | 5         |
| Base backoff                   | `QUEUE_RETRY_DELAY`     | 1 000 ms  |
| Backoff cap                    | `QUEUE_RETRY_MAX_DELAY` | 60 000 ms |

`min(delay × 2^(attempt-1), cap)`, so 1 s → 2 s → 4 s → 8 s. An unclassified
throw is retried; a caller signals permanence with `retryable: false`, which
BullMQ receives as an `UnrecoverableError`.

Concurrency per queue: mail 5, notification 5, maintenance 1, digest 2. The
in-process dispatcher drops a job when its backlog exceeds
`concurrency × 50` — a hard-coded bound with no configuration.

## Dead-letter

Redis list `dead-letter:jobs`, `LPUSH` + `LTRIM` to 500. Entry: `{queue, job,
dedupeKey, attempts, error, permanent, failedAt}`.

Only the in-process dispatcher writes it. **With BullMQ, exhausted jobs land in
BullMQ's own `failed` set and the list stays empty** — the dead-letter feature is
an in-process-only artefact.

There is no route to read it. `size()` feeds the `dead_lettered_total` gauge and
an alert fires above 1 for an hour, but "which jobs" means reading Redis.

## Idempotency

`Idempotency-Key` header, **required** — absent means 400, never auto-generated.
Opt in per route with `@Idempotent()`.

| Property             | Value                                                                             |
| -------------------- | --------------------------------------------------------------------------------- |
| Key                  | `idem:<scope>:sha256("<method>:<path>:<key>")`, scoped to user id, else IP        |
| Path                 | matched route **pattern** + sorted params, so `?page=2` and `?page=3` are one key |
| In-flight claim TTL  | 60 s                                                                              |
| Completed answer TTL | 24 h                                                                              |
| Body cap             | 64 KiB — beyond that, status-only replay                                          |

Three outcomes: `claimed` (do the work), `pending` → **409**, `complete` → replay
the stored status and body verbatim. A status ≥ 400 releases the key rather than
recording it, so a corrected retry is not answered 409 for a day.

**Fails open.** An unreachable Redis means the request proceeds without
idempotency. Rationale at `idempotency.service.ts`: failing closed would turn a
cache outage into an application that cannot write anything. It uses Redis
directly rather than `CacheService`, precisely because the cache's
fail-open-means-miss would silently invert this guarantee.

## When Redis dies

| Mechanism         | Behaviour                               |
| ----------------- | --------------------------------------- |
| Rate limiting     | fails **open** — no limiting            |
| Job deduplication | fails **open** — the job runs           |
| Idempotency       | fails **open** — the request proceeds   |
| Queue driver      | **does not switch** — `enqueue` rejects |

This is a consistent, deliberate posture: a dead cache must not become an outage
of the product. The cost is stated plainly — an outage removes exactly the
protections you want during an incident.

## Security controls

- Every key is namespaced by `RedisClientService`, so throttle counters, dedupe
  keys and dead-letter entries cannot collide with cache keys or across
  deployments.
- The idempotency key is a fixed-width SHA-256, so an attacker-supplied 64 KB
  key cannot be written into shared keyspace.
- The dedupe key is a SHA-256 of a canonical JSON array — **no recipient address
  appears in Redis**, in a key listing, or in a dead-letter entry.
- Throttle counting is a Lua `EVALSHA`, so read-then-increment is atomic.
- Idempotency replay is scoped to the caller's user id, so two users cannot
  collide on one key.
- Redis reconnect is bounded at 4 attempts, so a dead client is a miss rather
  than a hang.

## Standards alignment

Not a compliance claim — see [../auth/INTRODUCTION.md](../auth/INTRODUCTION.md).

| Requirement                             | Status      | Notes                                                                               |
| --------------------------------------- | ----------- | ----------------------------------------------------------------------------------- |
| ISO 27001 A.8.14 Redundant processing   | **partial** | BullMQ gives durability; the default in-process driver loses queued work on restart |
| ISO 27001 A.8.11 Data backup            | **not met** | no queue state is backed up anywhere                                                |
| HIPAA §164.308(a)(7)(ii)(A) Data backup | **not met** | same                                                                                |
| GDPR Art. 5(1)(e) Storage limitation    | **met**     | completed jobs removed after 3 600 s, failed after 86 400 s                         |
| GDPR Art. 32 — resilience of processing | **partial** |                                                                                     |

## Known gaps

| #   | Gap                                                                                                                                      | Where                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | **No runtime failover between drivers** — the one mechanism that fails _closed_                                                          | `queue.module.ts`          |
| 2   | **BullMQ never writes to the dead-letter list**                                                                                          | `bullmq.dispatcher.ts`     |
| 3   | `QUEUE_JOB_TIMEOUT` is configured, validated and **never read**; no execution timeout exists, so a hung processor holds its slot forever | `queue.config.ts`          |
| 4   | In-process jobs are lost on restart                                                                                                      | `in-process.dispatcher.ts` |
| 5   | Backlog bound is a hard-coded `× 50`                                                                                                     | `in-process.dispatcher.ts` |
| 6   | `depth()` reports `failed: 0` on the in-process driver, so the health check cannot see its failures                                      | `in-process.dispatcher.ts` |
| 7   | The dead-letter list has no read route and no TTL — only `LTRIM` at 500 bounds it                                                        | `dead-letter.service.ts`   |
| 8   | `queue/README.md` claims runtime fallback on a Redis outage; selection is boot-time only                                                 | `README.md`                |
| 9   | There is no list of the jobs that are running — only a job by its id                                                                     | `jobs.controller.ts`       |
| 10  | A job that never checks for a cancellation runs to completion                                                                            | `queue.interface.ts`       |

## Where to go next

- [README.md](README.md) — the full design.
- [../mail/INTRODUCTION.md](../mail/INTRODUCTION.md) and
  [../notification/INTRODUCTION.md](../notification/INTRODUCTION.md) — the two
  heaviest producers.
