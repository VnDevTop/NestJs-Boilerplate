# Queue

Background work: mail now, notifications and retention next. A request enqueues
and returns; nothing here runs inside a request.

```text
queue
├── queue.interface.ts          JobQueue, Job, JobResult
├── retry.policy.ts             backoff, retryability, the dedupe window
├── redis-client.service.ts     redis for bookkeeping, not for cache
├── dedupe-key.ts               builds the key a job is identified by
├── dedupe.guard.ts             stops the same work being done twice
├── dead-letter.service.ts      where jobs go when nothing else will work
├── processor-router.service.ts job name -> the processor that handles it
├── processors/mail.processor.ts    the only implementation of sending mail
├── in-process.dispatcher.ts    runs jobs here, under a bounded limiter
├── bullmq.dispatcher.ts        enqueues to redis, when bullmq is installed
└── queue.module.ts             picks one of the two at boot
```

## Two drivers, one implementation of the work

`InProcessDispatcher` and `BullMqDispatcher` both satisfy `JobQueue`, and both
hand the job to the same `ProcessorRouter`, which calls the same
`MailProcessor`. What is duplicated is the retry _loop_, because a queue backend
has one and a plain process does not. The retry _decisions_ come from
`retry.policy.ts` in both cases, and both read the numbers from `queue.config.ts`,
so enabling the queue does not change how many attempts a job gets.

This matters more than it looks. The in-process path is the one nobody exercises
in development when the queue is on, and the one that runs during a redis outage.
Two implementations of a send is how a bug reaches production through the path
that was never tested.

## Why deduplication sits around the processor

A queue is at-least-once: a job can be delivered twice, and that happens at
_execution_, not at enqueue. A check in `enqueue` would never see the second
delivery.

| Outcome                       | What happens to the key                            |
| ----------------------------- | -------------------------------------------------- |
| First delivery                | `SET NX` succeeds, work runs                       |
| A redelivery racing the first | `SET NX` fails, work is skipped                    |
| Retryable failure             | The key is **released**, so the retry can claim it |
| Success                       | Held until the TTL                                 |
| Permanent failure             | Held, the job is finished                          |

Releasing on a retryable failure is the load-bearing part. Holding the key would
make the retry skip itself, bullmq would record success, and the mail would never
be sent — with no error anywhere. `dedupe.guard.spec.ts` asserts that release.

**A redis outage fails open.** `setIfAbsent` answers `null` when it cannot ask,
and the job runs anyway. A duplicate is cheaper than a lost email.

The key lifetime is `retryWindowMs()`, the sum of every wait the retry budget
allows. A key that expired mid-retry would let a redelivery through as a new job,
which is the duplicate it exists to prevent.

## What the in-process dispatcher does that a queue would

- A concurrency limit per queue, so six maintenance jobs cannot occupy the pool
  that mail needs. `queue.config.ts` gives each queue its own number.
- A backlog bound of `concurrency * 50`. Beyond that it drops the job and logs an
  error. The backlog is heap: a traffic spike that outruns the provider would
  otherwise take the process down.
- Tracked retry timers, cleared on shutdown. An untracked `setTimeout` keeps the
  event loop alive and hangs the suite.

## BullMQ is optional

`bullmq` is resolved through `loadOptional`, so it is never a static import: a
bare import is resolved at build time and a deployment without the package would
fail to start rather than fall back. It is a dev dependency here so the adapter can
be tested against the real thing; a production deployment that does not enable the
queue does not need it.

A permanent failure is signalled by throwing an error named `UnrecoverableError`.
bullmq checks `err instanceof UnrecoverableError || err.name === '...'`, so the
name is enough and the class does not have to be imported.

## Cron entries do not live here

There is no `@Cron` decorator in this module. The only recurring work is the
retention job, which arrives with Phase 16. A cron entry today would enqueue a job
that no processor claims, which the router reports as a permanent failure and the
dead-letter list then fills with every night.

When the entries land they will use `@nestjs/schedule` rather than a queue
backend, so they keep firing when redis is down — which is when the database most
needs cleaning.

## The dead-letter list is redis, not a table

It is operational data, read by a human at 3am, worthless after a few days. A
Postgres table would mean something Phase 16 has to remember to purge. In redis the
TTL does the cleanup. Trimmed to 500 entries, and every write is best effort: when
redis is why the job failed, the log line is the only record, and that is
deliberate.

## Idempotency

`IdempotencyService` is here rather than in `core/cache` because it is **not** a
cache, and reusing the cache would have inverted its failure mode.

`CacheService` fails open by design: an unreachable store is reported as a miss, so
a redis outage costs a round trip rather than returning 500s. That is right for a
cache. Here it is catastrophically wrong — **a miss on an idempotency check means
the request is treated as new**, which is precisely the duplicate the feature exists
to prevent. So the store is redis directly, and the outage is handled explicitly.

It still fails open, deliberately: an outage means every mutating request is
processed without the protection — degraded, not broken. Failing closed would turn a
redis outage into an application that cannot write anything.

### The two windows

| Entry                | Default | Job                                                 |
| -------------------- | ------- | --------------------------------------------------- |
| in flight (`SET NX`) | 60s     | catch the second copy arriving while the first runs |
| completed answer     | 24h     | serve a retry from a client that was offline        |

They are deliberately very different. The in-flight window has to be long enough to
catch a genuine duplicate and short enough that a request wedged for minutes does
not answer 409 to everyone for the rest of its natural life. The completed window
has to outlive a client's downtime, not just its timeout — the same 24 hours as the
emailed links, for the same reason.

`complete` **extends** the ttl rather than setting a second key. Without that, every
retry more than a minute after the first would run the work again — the exact
failure this feature prevents, appearing only in production.

### Keys

`idem:<scope>:<sha256(method:path:clientKey)>`, scoped by the caller's user id.

The digest is fixed width because the client's key is attacker-controlled and
unbounded: a 64KB redis key written by a caller is a denial of service against an
instance shared with the queue. The path is the matched route plus its sorted
params — **not `originalUrl`**, whose query string would make `?page=2` and `?page=3`
two different keys for one action.

### It goes through `RedisClientService`

`setIfAbsent` applies the configured key prefix; a raw `getClient().set()` does not.
A store that writes through one primitive and reads through the other writes under
one key and looks under another — and looks like a key that was never claimed, on
every request, forever. `get`, `set` and `delete` were added to that class for
exactly this reason.

## Tests

The queue's own tests run against the real `bullmq` package, because an adapter
that has never run is one that is broken.

The deduplication key is the exception. `dedupe.guard.spec.ts` drives a fake
redis whose `SET NX` and `DEL` answers the test chooses, because the behaviour
worth testing is the release path — a key held across a retryable failure makes
bullmq record success and the mail never go out — and that is a property of the
guard's calls, not of a server's implementation.

What the suite asserts past that point is the _call_ — the queue options, the
per-queue concurrency, that a worker is opened only for a queue something was
actually enqueued on. A spec that started a real worker would be a second
integration suite in a file that runs on every commit, and its failures would be
about redis latency rather than about this adapter.

The one thing that genuinely needs the installed package is `isAvailable()`, and
it is the case the whole abstraction exists for. `test/e2e/optional-dependencies.e2e-spec.ts`
covers it end to end: the application boots with `QUEUE_ENABLED=true` and a
driver it cannot use, and `JOB_QUEUE` resolves to the in-process dispatcher.

The in-process driver is covered with no redis at all, which is the shape of a
deployment with `QUEUE_ENABLED=false`. Both paths go through the same processor
function, and `test/e2e/optional-dependencies.e2e-spec.ts` boots the application
with the queue switched on and no driver available, to check the module picks the
fallback instead of refusing to boot.
