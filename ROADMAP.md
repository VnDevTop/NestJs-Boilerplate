# Roadmap

What this template already does, and the enhancements worth building on top of
it. Written for someone about to add features, so each item says what it involves
and what it costs, not just what it is.

[PLAN.md](PLAN.md) is the phase by phase record of what was built.
[CHANGELOG.md](CHANGELOG.md) is what each change did and why.

---

## Shipped

The boilerplate is complete through production hardening. This is a working
starting point rather than a scaffold to fill in.

| Area            | What works                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Sessions        | Rotating refresh tokens, locked so concurrent refreshes have one winner; replay treated as theft                               |
| Devices         | Fingerprinted by user agent, revocation cascades to tokens                                                                     |
| Two-factor      | Optional TOTP, secret encrypted at rest, single use steps, one time recovery codes                                             |
| Authorisation   | `@Roles()`, `@ManagerOnly()`, and `@Permissions()` against a real permission table                                             |
| Sessions        | Listable and individually revocable; logout everywhere is immediate, not a token-expiry wait                                   |
| Configuration   | Namespaced and typed, whole environment validated before anything connects                                                     |
| Cache           | Redis or Valkey with request coalescing, stale while revalidate, and an auth path                                              |
| Rate limiting   | Counted in Redis, so it holds across replicas; two buckets per credential route, plus a lockout                                |
| Mail            | Swappable transport, queued so a slow provider cannot fail a signup; verification and reset                                    |
| Background jobs | Provider-level queue with an in-process fallback, retries, deduplication and a dead-letter list                                |
| Data retention  | Nightly batched cleanup with a dry run, run history and an admin route                                                         |
| Notifications   | Telegram, Slack, Discord, operator mail and the log, one interface, per-user opt-out                                           |
| Passwords       | Configurable policy in zod, an optional `zxcvbn` score, a breach check by k-anonymity, and the last N hashes rejecting reuse   |
| Lockouts        | Two of them: a temporary Redis block, and a permanent one an owner or an operator can clear                                    |
| Verification    | A confirmed address, enforced before the routes that change how an account authenticates                                       |
| Audit           | An append-only trail with actor, target, before/after diff, ip, agent and request id, and a redactor that no credential passes |
| Idempotency     | An `Idempotency-Key` header on mutating routes, replaying the original answer to a retry                                       |
| Concurrency     | A `@VersionColumn()` on the rows a request reads before it writes, so a lost update is a 409                                   |
| Privacy         | Erasure with a grace window, and a streamed export of everything held about an account                                         |
| Observability   | Request id, JSON production logs, liveness and readiness kept apart                                                            |
| Operations      | Reviewed migrations, idempotent seed, two stage image, compose stack, CI                                                       |

## Open decisions

Not features. Each is a decision that has not been made, and the cost of leaving
it unmade is the point.

| Decision                                            | Why it matters                                                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Restrict `GET /users/:id` to the owner or an admin  | Any authenticated user can read another user's profile, email included                                                            |
| Paginate the listing routes                         | `GET /users` and the admin dashboard return every matching row                                                                    |
| Who may read the audit trail                        | It is written for every privileged action, and there is no route that reads it back                                               |
| Replace the account-lockout thresholds in config    | A permanent lockout is a denial-of-service surface; only confirmed accounts can be locked, and that is code rather than a setting |
| Whether the audit writer should ever fail a request | It never does, so the trail can have holes. Failing closed trades that for an application that cannot write anything              |

---

## Enhancement plans

Ordered by what most real projects need first. Each is a plan, not a promise.

### 1. Email — built, Phase 14

Delivered, along with the queue it needed (Phase 15). Kept here because the
shape is worth reading before replacing any of it.

- A mailer behind an interface, so the transport is swappable and tests use a
  fake. Welcome on registration, email verification, password reset, a notice
  when a new device signs in, and a notice when 2FA is enabled or disabled.
- Verification and reset tokens belong in a table with an expiry and a
  single-use column, not in the JWT signed by the existing secret. They outlive
  one request and are consumed by a lookup, which is a different shape from a
  session token.
- Sending happens on a queue, not in the request. A slow SMTP provider must not
  be able to fail a signup.
- A user is not fully registered until the address is verified, and a verified
  address is the precondition for password reset.

**Watch out:** an account enumeration leak in the "forgot password" response.
Answer the same way whether or not the address exists.

### 2. Data cleanup — built, Phase 16

Delivered as a nightly batched job with a dry run and run history. Kept for the
reasoning about why deletes are batched rather than issued as one statement.

The database only gets bigger, and soft deleted rows and revoked tokens are pure
cost once nobody can use them.

- A scheduled job, not a cron entry someone remembers. It runs inside the
  application so it is observable, and it takes a lock so two replicas do not run
  it at once.
- Soft deleted users after 30 days, expired refresh tokens, and two-factor
  secrets for users who no longer exist.
- Batched deletes with a limit per pass. A single `DELETE` over a large table
  locks it and can take the site down, which is a self inflicted outage.
- A dry run mode that reports what would be deleted. The first time this runs
  against real data, the operator should see the count before it happens.
- Retention is a policy, not a constant. Thirty days is a default, and the
  decision belongs to whoever owns the data.

**Watch out:** foreign keys. Deleting a user cascades to devices and tokens by
design, so the order matters and a partial run must be restartable.

### 3. Auth and authorisation through the cache — built, Phase 17b

Done, and it went further than caching: the shape that made it safe turned out to
be the same shape that made revocation precise.

This section recommended a **negative** cache only, on the reasoning that a stale
positive entry is an authorisation bug. That reasoning held, and the answer was
not to avoid the positive entry but to make it impossible to leave one behind:

- Permissions are cached **per role**, so there is one entry per role rather than
  one per user, and a role change is one delete rather than a delete per holder.
  There is no pattern delete, by choice, so a per-user key would have turned every
  role change into a scan of the user table.
- **Every write that changes an authentication answer drops the entry**, after its
  transaction commits rather than inside it. A delete inside the transaction lets a
  request in between refill the entry from the row being revoked, and that entry
  then outlives the token it wrongly admitted. That is a silent failure, which is
  the worst kind, so it is the reason the ordering is the way it is.
- **A guard test makes it unforgettable.** The phase planned a TypeORM subscriber
  for this, and the subscriber turned out to be impossible: TypeORM builds them
  with `new target()`, so there is no dependency injection, and every write whose
  invalidation matters is a query-builder write that arrives with no row id. A
  test now asserts that a revocation-critical column is only written in files that
  also invalidate, which fails the build rather than quietly weakening a logout.
- **The TTL is a backstop, not the mechanism**, and it is configurable because the
  window is a security property.

The sharp edge is still the same one, and it has not gone away: a role escalation
survives in the cache until something invalidates it. What changed is that there
is now a check which notices when the invalidation is missing, instead of a
convention that everyone is asked to remember.

### 4. Notifications — built, Phase 18

Delivery to Telegram, Slack, Discord, an operator mailbox and the log, behind one
interface so a feature emits an event and does not know which channels exist.

- **`NotificationChannel { name, isEnabled(), send() }` is the whole extension
  story.** A third party adds a channel by providing a class and adding it to one
  factory. Nothing in the service changes, and there is no `if (channel === …)` in
  the delivery path.
- **No channel needs a package.** Telegram is raw HTTPS to the Bot API; Slack and
  Discord are incoming webhooks; the email channel delegates to `MailService`. The
  only transport is `HttpModule`, which the boilerplate already depends on. That is
  the whole reason `optionalDependencies` was not needed for any of them.
- **Failure is isolated per channel, and so is retry.** A Telegram outage does not
  cost the Slack copy, and the retries are spent on the channel that failed rather
  than re-attempting all four — a queue-level retry would have delivered the Slack
  alert five times because Telegram was down.
- **A partial delivery is a success.** The processor asks "did anybody receive
  it", not "did every channel", which is the opposite of `MailProcessor` and for a
  concrete reason: mail is one recipient, a notification is several.
- **Every attempt is logged, including the refusals.** `notification_logs` gets one
  row per channel, with the rendered body, so "did it arrive" and "what did it
  actually say" are answerable without a template history. The retention job cleans
  it at 30 days.
- **Per-user preferences, opt-out.** Absence means on, so a fresh install is not
  silent. Cached per user, invalidated once after the whole batch rather than
  between writes.
- **Seven events**: registration, deletion, a blocked sign-in, a new device, 2FA
  enabled and disabled, and a retention anomaly. Each takes only the fields it
  renders, so no event can read `user.password`.

Two things from this section that did not survive contact with the code:

- **HMAC-signed webhooks are not built.** The plan proposed them for a _receiver_.
  This module is a sender, and an outgoing webhook signed with a shared secret is a
  secret the receiver now has to store — which is the opposite of the property
  these channels were chosen for. Signing belongs on the inbound side, which is
  Phase 19's audit and idempotency work.
- **A generic webhook channel is not built.** Telegram, Slack and Discord each have
  their own class because their payloads genuinely differ — Discord ignores Slack's
  `text` and posts an empty message. A generic webhook that accepted arbitrary
  payloads would need per-destination configuration to format anything, which is
  the configuration this design removes.

### 5. Account security — built, Phase 19

The phase whose features real deployments get asked about, and the one with the
most refusals in it. Each item says what it left out, because that is where the
design is.

- **A password policy in zod**, with an optional `zxcvbn` score. The DTOs keep
  their widest decorators on purpose: a decorator cannot read runtime config, and
  the rule lives in one object rather than as a number repeated in two DTOs.
- **A breach check by k-anonymity**, so the password never leaves the server —
  only the first five characters of its SHA-1 do. It fails open on purpose; the
  alternative makes a third party an availability dependency for your signup.
- **The last N hashes, rejecting reuse.** Five scrypt derivations per check is
  the price, and it is the reason the default is five rather than twenty.
- **A verification gate** on the routes that change how an account
  authenticates. Sign-out is deliberately ungated: a user who suspects a
  compromise and cannot sign out is worse off than one whose address is
  unconfirmed.
- **Two lockouts.** A temporary Redis block, and a permanent one — which is a
  denial-of-service surface before it is a defence, so only a _confirmed_
  address can be locked and that is code rather than a setting. A locked
  account answers with the same 401 as an unregistered one; the owner finds
  out from the mail, which is the only channel that reaches the person who
  can act on it.
- **An audit trail** with actor, target, before/after diff, ip, agent and
  request id. Every diff is walked and credential-bearing keys are replaced, so
  a year of "who changed what" is not also a year of every password hash. The
  writer never throws: an outage in the log must not become an outage in the
  product.
- **`Idempotency-Key`** on mutating routes, replaying the original answer to a
  retry. Required rather than generated — generating one would promise a
  guarantee the caller is not making.
- **A `@VersionColumn()`** on the rows a request reads before it writes, so two
  administrators editing the same profile produce a 409 rather than a silent
  lost update where both see 200.
- **Erasure with a grace window**, and a streamed export of everything held
  about an account that selects no credential at all.

What is not here: an admin route to read somebody else's audit trail, and a
generic signed webhook. The first is a decision about who may see the trail, and
the second is Phase 22's.

### 6. Background jobs — built, Phase 15

Both plans above needed one, and it is worth having on its own.

- A queue for anything a user should not wait for: email, cleanup, exports,
  webhooks.
- At-least-once delivery, with every job handler idempotent, because a queue
  gives you duplicates rather than promises.
- Retries with exponential backoff and a dead letter queue, so a poison message
  does not block the queue behind it.
- The handler re-checks its own precondition, because state can change between
  the enqueue and the run.

### 7. The rest, in rough order

Each earns its place in a real project. None is a template's job to build.

- **Pagination and filtering.** Cursor pagination for anything that can grow
  without bound. Offset pagination skips and duplicates rows when the underlying
  data changes mid page.
- **File uploads.** Direct to object storage with a signed URL, so a large file
  never passes through the API process. Size and type validated on the signature
  request, not after the upload.
- **Audit log.** Who changed what, when, and from where. Append only, kept out of
  the tables it records, and queryable separately from the operational database.
  Written by an interceptor, so a new route is covered by default.
- **Account lockout.** Distinct from rate limiting, which limits a route. This
  limits an account, survives the counter being reset, and notifies the owner
  when it trips.
- **Permissions beyond roles.** `PermissionsGuard` is a placeholder. Roles cover
  the common case; a permission table and a decision about where permissions are
  assigned are what make it real.
- **Webhook signing and replay protection.** The same signing work the
  notification plan needs, for the outbound direction.
- **GDPR style data export and erasure.** A machine readable export, and an
  erasure that says what is deleted, anonymised, or kept for a legal reason.
- **Feature flags.** A kill switch for the risky path is worth more than a
  rollback, and it is cheaper to add before you need it.
- **Zero downtime migrations.** Expand, backfill, contract. A migration that
  renames a column in one step is an outage waiting for a deploy.
- **Read replica routing.** Worth it once reads dominate, and not before.
- **Localisation.** Message catalogues rather than concatenated strings, from the
  start, because extracting them later is painful.
- **API client generation.** Generate a typed client from the OpenAPI document
  the project already publishes, so the schema stops drifting.
- **Multi-tenancy.** Every table keyed by tenant, enforced in the repository
  rather than remembered per query. Far cheaper to start with than to retrofit.
- **Distributed locks.** Redis based, for the cases where a database row lock is
  not enough. The refresh rotation does not need one, which is why it uses a row
  lock.

---

## Explicitly not planned

So these are not proposed again.

- **A second cache driver.** `CACHE_BACKEND=memory` is for local development and
  nothing else. A configured but unreachable cache failing the boot is
  deliberate: silently serving per-process data looks like it works.
- **Pattern based cache invalidation.** Scanning a keyspace is unbounded on a
  shared server and a broad pattern fails silently. Callers that know what they
  changed pass those keys.
- **Shipping every optional integration as a dependency.** See the notification
  plan for why that is a cost, not a convenience.
- **A dependency injection rewrite.** Nest's own mechanism is what this template
  teaches.
