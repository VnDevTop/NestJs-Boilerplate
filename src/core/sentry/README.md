# Sentry

Unhandled errors, reported to Sentry. Or nowhere.

```dotenv
SENTRY_DSN=https://examplePublicKey@o0.ingest.sentry.io/0
SENTRY_RELEASE=1.0.0
```

```bash
npm install @sentry/node
```

## A DSN without the package reports nothing, and says so

`loadOptional` returns `null`, every method is a no-op, and the error filter still
logs locally. Nothing about the application's behaviour changes — the exception
still reaches the log, still reaches the client, still reaches whoever reads the
log.

A DSN set with the package absent logs a warning at boot rather than failing. That
state is worth distinguishing from "installed but no DSN", because it is the one
somebody will believe is reporting errors.

## `beforeSend` is the point of this integration

Sentry's defaults attach the **request headers, the cookies and the body** to
every event. Those are exactly where a password, a reset token and a two-factor
code arrive.

An error reporting service holding a sign-up body is a credential store with a far
larger blast radius than the database: it is a third party, with its own retention
policy and its own jurisdiction.

| Removed                        | Because                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| `request.headers`              | an `Authorization` header is a live credential               |
| `request.cookies`              | a session id                                                 |
| `request.data` / `body_string` | the body is where the password is                            |
| the query string               | `?token=` is a single-use reset, verification or unlock link |
| `extra.body/password/token`    | what this module would otherwise attach                      |

**Breadcrumbs are kept.** "This failed after the notification to Slack" is the
difference between a bug report and a puzzle, and they carry no request body.

## One event per incident, not per request

The error filter calls `captureException` once per unhandled exception and applies
no rate limit of its own. What stops one bug producing ten thousand events is
Sentry's own sampling and its own grouping — not a limit invented here, which would
drop the events nobody wanted as reliably as the ones somebody did.

## The release tag

`SENTRY_RELEASE`, falling back to the package version read through `createRequire`
(no `resolveJsonModule`, no JSON asset in the build).

Without a release, Sentry cannot tell a regression from the deploy that introduced
it, and its issue list is a wall of "new since Tuesday". Set it in CI from the git
SHA and the feature starts earning its keep.

## `tracesSampleRate: 0`

Spans go to OpenTelemetry — see [src/core/tracing](../tracing/README.md). Running
one request through two tracing systems doubles the cost and splits the trace in
two, so exactly one of them should be on.

## Flushed on shutdown

Sentry's transport batches, so a process that exits without flushing loses the
last few events — which are the ones around the reason it exited. `SentryModule`
flushes on `onApplicationShutdown`, after Nest has stopped the HTTP server, which
is when a shutdown error would otherwise have nowhere to go.

## The context attached to an event

```ts
sentry.captureException(error, {
  requestId,
  traceId,
  route, // the route pattern, never the url
  method,
  userId,
});
```

The route pattern rather than the url for the same reason the query string is
dropped: a reset link is entirely in the query string and works exactly once for
whoever holds it.

## Nothing here throws

This is called from an exception filter, which is the last place a process is still
running. An error reporter that throws turns a handled 500 into a dead process, so
every call is guarded and a failed report becomes a log line.
