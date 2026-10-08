# Health

Liveness, readiness and the shutdown flag that connects them.

```text
GET /api/v1/health/live     liveness, touches nothing external
GET /api/v1/health/ready    database and cache
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
