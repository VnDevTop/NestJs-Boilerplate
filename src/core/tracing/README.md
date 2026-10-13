# Tracing

OpenTelemetry spans for HTTP requests, slow queries and job execution.

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node
```

## `@opentelemetry/api` and nothing else

This is the vendor-neutral **interface** every tracing SDK implements — OpenTelemetry's own, Datadog's, Honeycomb's, somebody's file exporter written for a weekend.

**No SDK, no exporter, no collector.** Depending on those would choose the
deployment's tracing stack for whoever clones this, which is the one decision a
template should never make. What is missing without them is a place to send spans,
and that is a deployment's business.

So there are three states, and all three are supported:

| Installed               | Behaviour                           |
| ----------------------- | ----------------------------------- |
| nothing                 | every method is a no-op, same speed |
| the API package, no SDK | spans are created and discarded     |
| API + SDK + a collector | traces appear, with no change here  |

## And the integration already in this repository

`app.module.ts` registers `@nestjs/observe` when `OBSERVE_APP_KEY`,
`OBSERVE_APP_SECRET` and `OBSERVE_SERVICE_ID` are set.

**That is an alternative, not a partner.** Two tracing systems in one process
means two spans for one request and no way to tell which is the real one — pick
one. This was built anyway because Observe is a hosted service, and a boilerplate
that cannot be traced without signing up for something is not free.

## What is instrumented

| Span            | Where                      | Attributes                       |
| --------------- | -------------------------- | -------------------------------- |
| `http.request`  | a global `APP_INTERCEPTOR` | method, route pattern            |
| `db.query`      | `logQuerySlow`             | statement (never the parameters) |
| `queue.process` | `ProcessorRouter.process`  | job name, dedupe key             |

**The HTTP interceptor is registered first**, so everything below it — guards,
services, queries — is inside the request's span. A trace that starts after the
authentication work has already happened is a trace missing its slowest and most
interesting part.

**The database spans come from `logQuerySlow`, not `logQuery`.** TypeORM calls
`logQuery` for every statement, and a span per statement turns a burst of traffic
into a burst of tracing traffic; the sampler then gets configured to drop almost
everything, and the one slow query somebody wanted is the one that got dropped.
`logQuerySlow` already knows the duration, so nothing is timed twice.

**The parameters never go into a span.** TypeORM passes them to the logger and the
parameters are where a password hash, an address and a reset token all live. The
query text is safe — it has no row in it — and it is the part that makes the span
useful.

**Route patterns, not urls.** `/users/:id` is one series. `/users/8f1c…` is one
series per user, which is a cardinality bomb in a store with a different retention
policy to the database.

**A returned `HttpException` marks the span failed.** A 4xx on an otherwise
successful span is invisible — OpenTelemetry only marks a span failed when it is
told, and a returned exception is a return. Without this the dashboard says
everything is fine while every request is being rejected.

## A job is not inside a request

The thing that enqueued it answered minutes ago, so without a span here a job's
work has no trace of its own and cannot be followed from the enqueue to the
provider call. `queue.process` is that span, and it is what the `traceId` on a
job's log lines comes from.

## `traceId` on every log line

`AppLogger` reads the id in scope rather than being handed it, so a log written
deep inside a service is correlatable without the call site knowing anything about
tracing. **Omitted when there is none** — `traceId: ''` on every line of a
deployment with no tracing installed is a field a pipeline has to learn to skip, and
one that is always empty is one nobody looks at.

## Nothing here can throw

`startSpan` catches, and the TypeORM logger guards every call. A sampler that
raises, a broken exporter, a logger inside the database path: tracing is never the
thing allowed to cause an outage, and a logger that logs on every query failure is
the outage this module exists to help diagnose.
