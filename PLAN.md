# NestJS Boilerplate Implementation Plan

## Goal

Take a correct auth skeleton to something a real product runs on: a query layer
that pages honestly, an isolation model that survives its first customer, and the
integrations — search, bulk data, billing, webhooks — that every product ends up
needing and nobody wants to write twice.

Phases 0–22 built the security and operations foundation and are recorded in
[CHANGELOG.md](CHANGELOG.md). What follows is the second half.

Layer boundaries are unchanged. Everything below slots into `configs`, `database`,
`common`, `core` and `modules` as they exist today.

Gaps this plan closes:

- **Nothing pages.** `GET /users` and the admin listings return every matching row,
  and `PaginationQueryDto` exists unused.
- **There is no query language.** No full-text search, and no safe way to express a
  user-supplied filter.
- **Nothing records progress.** An import large enough to need a job has no way to
  report where it got to, or be cancelled.
- **The audit trail cannot be read.** It is written for every privileged action and
  no route returns it.
- **HTTP is called by hand.** Each call site passes its own `HttpService` and
  invents its own notion of which failure is worth retrying.
- **There is no integration point in either direction.** No outbound webhook, no
  inbound one, no event bus between modules.
- **Multi-tenancy is not addressable.** Every table would need a column, and every
  index and unique constraint with it, before the first customer rather than after
  the hundredth.
- **No billing, no bulk data, no realtime, and no search beyond what SQL can do.**

---

## Shipped

Phases 0–22. The implementation detail lives in [CHANGELOG.md](CHANGELOG.md);
what each one _is_ is beside the code it produced.

| Area          | What exists                                                               |
| ------------- | ------------------------------------------------------------------------- |
| Auth          | refresh rotation with theft detection, devices, TOTP, recovery codes      |
| Authorisation | `@Roles()`, `@ManagerOnly()`, `@Permissions()` against a permission table |
| Sessions      | four revocation scopes, listable and individually revocable               |
| Configuration | namespaced, typed, whole environment validated before anything connects   |
| Cache         | Redis or Valkey with coalescing, stale while revalidate, an auth path     |
| Rate limiting | counted in Redis across replicas, two buckets per credential route        |
| Mail          | swappable transport, queued, nine templates, database-managed             |
| Queue         | two drivers, retries, deduplication, dead-letter list                     |
| Retention     | nightly batched cleanup, dry run, run history                             |
| Notifications | five channels, per-user opt-out, every attempt logged                     |
| Audit         | an append-only trail with a redactor no credential passes                 |
| Privacy       | erasure with a grace window, a streamed export of everything held         |
| Observability | request id, JSON production logs, split liveness and readiness            |
| Operations    | reviewed migrations, idempotent seed, two-stage image, CI                 |

---

## Group 1: Query and data foundation

Phases 23–31. Everything in Groups 4–8 stores data, and they all need a list route
that pages and a tenant column that exists. This group is the floor.

### Phase 23: Cursor pagination

Status: Done — see [CHANGELOG.md](CHANGELOG.md)

Goal: no listing route returns an unbounded result set.

- [x] Cursor pagination on `(createdAt, id)` for every route that can grow
- [x] `meta: { nextCursor, hasMore }` in the existing response envelope
- [x] Filter and sort DTOs with an **allow-list**, because sorting by an arbitrary
      column name is SQL injection with a different name
- [x] `GET /users` and the admin listings migrated
- [x] `PaginationQueryDto` either wired in or deleted — an unused DTO reads as a
      plan and is not one. Deleted.

Done when a concurrent insert between two page requests cannot make a row appear
on both pages or on neither. **Met, and asserted as a test** rather than argued in
a comment: `cursor-pagination.spec.ts` pages a set with a row inserted between two
reads and checks that every original row appears exactly once and the new one not
at all.

Carried into Phase 24: the boundary is generic over the sort column, so a route
sorting by something other than `createdAt` needs nothing new — only an index
that leads with that column and carries the id after it.

### Phase 24: A reusable query criteria object

Status: Done — see [CHANGELOG.md](CHANGELOG.md)

- [x] `QueryCriteria` built once from a DTO and consumed by any repository
- [x] Sorting, filtering and paging in one place rather than per service

Done when adding a list route needs no new pagination code. **Met, and asserted
as a test** rather than argued in a comment: `query/adding-a-route.spec.ts` adds
a route that does not exist — a fictional table — and shows the whole of it is a
DTO, a spec, and one call.

What replaced what: `common/query/` now owns sorting, filtering and the keyset
walk, and the two Phase 23 pieces that it subsumed — `pagination/sort.ts`'s
`resolveSort` and `pagination/cursor-pagination.ts`'s `paginateByCursor` — are
deleted rather than kept as a second way to do the same thing. `common/pagination/`
keeps the cursor codec and the two response shapes, which are transport details
rather than query details.

**A route's query surface is now one object.** `USER_QUERY_SPEC` says which
fields may be filtered and sorted and which column each one means, and it is
checked against the DTO at compile time in both directions: a filter the DTO does
not declare is a filter that could never fire, and a DTO property no filter
declares is a parameter the client can send and the route ignores.

**The operator comes from the spec, never from the request.** The set is closed
and each operator is a literal in the source, so there is no path from a request
to a fragment of SQL.

**The scope is not a filter.** `GET /auth/devices` answers "your own devices", and
that is applied by the service rather than by anything the client sends.

### Phase 25: Job progress and cancellation

Status: Done — see [CHANGELOG.md](CHANGELOG.md)

- [x] Progress recorded per job: processed, total, current item, started, finished
- [x] `GET /jobs/:id` and a cancel endpoint
- [x] Cancellation honoured at the next chunk boundary, not mid-write

Done when a five-minute import can be watched and stopped. **Met, and asserted as
a test** rather than argued in a comment: `retention.service.spec.ts` cancels a
run mid-table and shows that the batch in flight finished and the next one never
started, and `jobs.controller.spec.ts` shows the three answers the route gives —
a job, no such job, and a store that cannot be reached.

**A job has an id, and the queue mints it.** `enqueue` returns it, and it is the
handle for everything else: `GET /jobs/:id` and `POST /jobs/:id/cancel`. The
queue mints it rather than the caller so a job cannot be queued without one and
two replicas cannot mint the same one.

**The progress lives in redis, not in a table.** It is live state about work
that is happening now, it is read by a person watching a run, and it is
worthless a day later. The TTL is the cleanup, so nothing has to be scheduled to
delete it.

**A cancellation is a flag, not a kill.** The job asks whether it should stop at
a boundary it knows is safe, and stops there. The retention run checks between
batches, and each batch is its own transaction, so stopping there leaves the
table in a state an interrupted run would also leave.

**A cancelled job is neither a failure nor a success.** It is not retried, not
dead-lettered, and its deduplication key is released. The job's record says
`cancelled`, which is a fourth answer that the other three do not cover.

### Phase 26: An audit read surface

Status: Done — see [CHANGELOG.md](CHANGELOG.md)

- [x] `GET /admin/audit` behind `@ManagerOnly()` and a new `audit:read`
- [x] Filter by actor, action, target and window, cursor-paged
- [x] The answer to "every `users.update` on this account" reachable from the API
- [x] A decision recorded about **who** may read it, not left implicit

Done when an incident can be investigated without leaving the application and
writing SQL. **Met, and asserted as a test** rather than argued in a comment:
`test/e2e/audit-read.e2e-spec.ts` performs a privileged action over HTTP, reads
the trail back through the API filtered to that action and target, and shows
that an ordinary user and a plain administrator are both refused.

**The query surface is one object.** `AUDIT_QUERY_SPEC` says which fields may be
filtered and which column each one means, `AuditQueryDto` says what the request
may contain, and the two are checked against each other at compile time in both
directions — a filter the DTO does not declare could never arrive, and a DTO
property no filter declares is a parameter the client can send and the route
ignores.

**Every value is bound.** The action, the target and the window are parameters;
the column names come from the spec and never from the request.

**The window is two bounds, and the offset is required.** `from` is `>=` and `to`
is `<=`, and a timestamp without a timezone is refused rather than interpreted:
it means different instants on two deployments, and both answers are correct.

**The action is matched exactly.** The action names are a closed vocabulary, one
per privileged route, asserted by `audit-policy.spec.ts`. "Every `users.update`"
is not "every action containing the text `users.update`".

**Who may read it is decided, and the decision is recorded.**
`audit:read` is held by the super administrator alone. Not because the trail is
dangerous to look at — an administrator already holds `UserRead`, so the personal
data in the snapshots is not new to them — but because of _who_ it describes:
every privileged actor, with the failures included. The manager gate cannot be
the thing that decides it either, because `isManager` is a column an
administrator can set on any account through `PATCH /users/:id`, so a route
gated on it can be widened by the very people it reports on. The cost is stated
rather than hidden: an ordinary administrator investigating an incident needs an
escalation.

**The read fails where the write does not.** `record()` never throws, because an
outage in the log must not become an outage in the product. A read that failed
and answered "no rows" would be a lie an investigator would act on, so the read
propagates the failure.

### Phase 27: A Lucene query parser

Status: Planned

Goal: one query language, reusable by every searchable entity.

`src/common/search/` holds the parser and **knows no entity**. Adding search to
`customers`, `orders` or `invoices` is one field-map file and no new
infrastructure.

- [ ] `ast.ts`: `BooleanQuery | FieldQuery | RangeQuery | PhraseQuery |
WildcardQuery | ExistsQuery | BoostQuery | MatchAllQuery`
- [ ] Tokenizer and recursive-descent parser
- [ ] Supported: `term`, `field:value`, `"phrase"`, `AND OR NOT`, parentheses,
      `[a TO b]` inclusive, `{a TO b}` exclusive, `>`, `<`, `>=`, `<=`, `wild*`,
      `f?y`, `fuzzy~`, `fuzzy~2`, `boost^3`, `field:*`, `\:` escaping
- [ ] **Refused and documented**: regex, script fields, nested queries. Not because
      they are hard — because they make the translator unprovable

### Phase 28: The field registry and the translators

Status: Planned

- [ ] `SearchFieldRegistry`: field → `{ type, searchable, filterable, sortable,
weight, column }`
- [ ] The **allow-list** is the injection boundary. An undeclared field is
      `UnknownFieldError` listing the valid names, never silently dropped
- [ ] The translator emits **parameterized values only**, and never interpolates
      query text into SQL
- [ ] Three translators: Postgres, in-memory predicate (unit tests), and a mock
- [ ] `search.test-kit.ts`: golden cases, fuzz, and a SQL-injection corpus —
      reusable by every entity's search

### Phase 29: The Postgres translator

- [ ] `tsquery` from the AST, not from a string the user typed
- [ ] `setweight()` per field for `ts_rank`
- [ ] `tsvector` column, GIN index, and a migration to populate it
- [ ] Facet counts over the same AST

### Phase 30: User search

- [ ] `POST /users/search`, permission-gated
- [ ] Six fields: `email`, `firstName`, `lastName`, `role`, `isActive`,
      `createdAt`
- [ ] Every field carries a weight, chosen rather than defaulted

### Phase 31: The search documentation

Status: Planned

The thing that makes this reusable rather than a parser somebody has to reverse
engineer.

- [ ] `src/common/search/README.md`: the field type table, the three capabilities
      spelled out, and how to register a new entity
- [ ] A worked example on an entity with a **different shape** — an `orders` or
      `customers` search with uuid, money-as-integer, keyword and date fields
- [ ] How a derived field works (`fullName` from first and last, no duplicate
      column), so `name:john` works
- [ ] The anti-pattern list: queries that must full-scan, wildcard `*`, sorting by
      a non-sortable field

---

## Group 2: Multi-tenancy

Phases 32–41. **Before** Groups 4–8, because a tenant column added afterwards means
touching every query, index and unique constraint again.

### Phase 32: The tenant column, present from the start

Status: Planned

- [ ] `tenant_id` on all seventeen tables, **always**, including while
      `MULTI_TENANT=false`
- [ ] Composite uniques: `(tenantId, email)`, and the same for every other natural
      key
- [ ] Migration with a fixed default tenant seeded, so the feature can be enabled
      without a backfill
- [ ] Indexes lead with `tenantId`
- [ ] `MULTI_TENANT=false` produces byte-identical behaviour to today

### Phase 33: The tenant registry

- [ ] A `tenants` table: slug, name, status, plan, and where its data lives
- [ ] Resolution from host, subdomain or header — the one untrusted input that
      decides what you can read
- [ ] An unknown or disabled tenant answers 401 rather than falling back to a
      default
- [ ] One fixed tenant row seeded for single-tenant deployments

### Phase 34: Tenant context

- [ ] `TenantContext` on AsyncLocalStorage, set before any guard runs
- [ ] Propagated into queued jobs, because a job with no tenant context is a job
      that writes in the wrong place
- [ ] Propagated into scheduled work

### Phase 35: Repository scoping

- [ ] A tenant-aware repository base class
- [ ] Scope applied at the repository, **never** per query — a query that has to
      remember is a query that will forget
- [ ] A test that fails when a repository method is added without a scope

### Phase 36: Row-level security

Status: Planned

Every table. RLS is not a replacement for the repository scope, it is the layer
underneath: an application bug that forgets the filter gets an empty result rather
than another customer's data.

- [ ] `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` on every table —
      without `FORCE`, the table owner bypasses it and TypeORM connects as the
      owner
- [ ] `USING ("tenantId" = current_setting('app.tenant_id', true))`, with `WITH
CHECK` so an insert cannot write into another tenant
- [ ] The application role documented as **not** a superuser, because a superuser
      bypasses every policy
- [ ] A second, non-superuser role for the app, created by the migration
- [ ] A test that proves the policy binds: a query with no tenant filter returns
      nothing rather than everything

### Phase 37: Cache namespacing

- [ ] `tenantId` folded into the key prefix in **one** place
- [ ] A test asserting no two tenants' entries can collide

### Phase 38: Per-tenant permissions

Status: Planned

- [ ] `permissions` and `role_permissions` gain `tenantId`
- [ ] `role:<tenantId>:<role>` cache keys
- [ ] The seeder clones the catalogue into each tenant rather than writing one
      global copy
- [ ] `PUT /admin/roles/:role/permissions` tenant-scoped
- [ ] No `roles` table: `users.role` stays a `varchar`. Converting it is its own
      refactor and would change the API surface for no gain here

### Phase 39: Per-tenant mail templates

- [ ] `email_templates` and `email_template_versions` gain `tenantId`
- [ ] An operator edits their tenant's wording and nobody else's
- [ ] The shipped `.hbs` files remain the fallback for every tenant

### Phase 40: Per-tenant retention

- [ ] The retention run iterates tenants
- [ ] `maintenance_logs` gains `tenantId`; the history API is tenant-scoped
- [ ] **Open decision, revisit past five tenants**: one job per tenant means N
      batch-delete passes a night. A single job scanning every tenant is
      compatible with the data but changes the API shape

### Phase 41: The isolation proof

Status: Planned

The answer to "how do you know it does not leak".

- [ ] CI runs the suite in **three modes**: `off`, `on`, and `on + RLS on`
- [ ] The third is the one that earns its keep: it turns "the scope looks right"
      into a check, because any test relying on a row it forgot to scope fails
- [ ] A cross-tenant isolation spec covering every path: read, write, delete, list,
      search, export, Excel export, background job, audit query, and cache
- [ ] A multi-tenant playground in `docs/installation.md`

---

## Group 3: The HTTP client

Phases 42–44. Before Group 4, because the first thing that genuinely needs
retry-until-it-holds is a webhook.

### Phase 42: A shared HTTP client

Status: Planned

`@nestjs/axios` is already a dependency and every transport already uses it. What
is missing is discipline, not a package.

- [ ] `HttpCoreModule`, global: one timeout configuration
- [ ] An error taxonomy — `retryable`, `permanent`, `throttled` — so no call site
      invents its own notion of which failure is worth another attempt
- [ ] `request-id` propagated onto every outbound request, so a third party can
      quote it back

### Phase 43: Circuit breaker and retry budget

- [ ] A breaker that opens on a threshold and half-opens to probe
- [ ] A retry budget, so a retry storm cannot outlive the outage that caused it

### Phase 44: Migrate the existing call sites

- [ ] `json-poster`, and the Slack, Telegram and Discord channels
- [ ] The password breach lookup
- [ ] Every hand-set timeout gone

---

## Group 4: Webhooks and events

Phases 45–52. Both directions, because the two problems are different problems.

### Phase 45: Outbound subscriptions

- [ ] Endpoint, subscribed events, secret, enabled — one secret per endpoint
- [ ] Secret rotation, with the previous secret still verifying for a window, so a
      deploy does not break verification halfway through

### Phase 46: Signing and replay protection

- [ ] `t=<timestamp>,v1=<hmac-sha256>` over `timestamp.body`
- [ ] A verification window, and a signed timestamp so it cannot be forged
- [ ] Constant-time comparison

### Phase 47: The SSRF guard

Status: Planned

**Not optional, and not polish.** A subscription endpoint is user-supplied, so
without this the feature is a way to read the cloud metadata service.

- [ ] Resolve the hostname, then check the resolved address — checking the string
      is defeated by DNS rebinding
- [ ] Refuse loopback, link-local, private ranges, and `169.254.169.254`
- [ ] Refuse redirects
- [ ] Bound the timeout and the response size
- [ ] A test proving a subscription pointed at the metadata address never connects

### Phase 48: Delivery

- [ ] Through the existing queue, so retries and the dead-letter list are already
      there
- [ ] Manual replay from the admin, **and the replay is itself audited**
- [ ] 4xx is permanent; 5xx and timeouts are not

### Phase 49: Inbound webhooks

- [ ] `rawBody` on the Nest factory — HMAC cannot be verified against a re-serialised
      body
- [ ] Per-provider signature verification
- [ ] Dedupe on the provider's event id: a repeat is acknowledged and dropped

### Phase 50: Service-to-service authentication

Status: Planned

For internal calls. **Not** HMAC — that is for parties you do not control.

- [ ] Service tokens: a subject, scopes, a short expiry, revocable
- [ ] Scoped exactly as permissions are, reusing the same vocabulary

### Phase 51: A domain event catalogue

- [ ] One module per aggregate, following the shape `notification.events` already
      has
- [ ] Events typed and named, so adding one does not mean editing another module

### Phase 52: The outbox pattern

- [ ] An event written in the same transaction as the state change
- [ ] A separate process publishes it
- [ ] Dual-write — writing the row and publishing separately — is how events go
      missing

---

## Group 5: Files and bulk data

Phases 53–58.

### Phase 53: Storage abstraction

- [ ] Presigned URLs, so a large file never passes through the API process
- [ ] A `memory` driver for local development and a `s3` driver for everything else
- [ ] The optional-package pattern, so a deployment without one still boots

### Phase 54: Upload validation

- [ ] Size and content type validated on the **signature request**, not after the
      upload
- [ ] A scan hook, so the signature is not the only gate

### Phase 55: Excel export

- [ ] `exceljs`, streaming — **not** the `xlsx` package, whose public npm build is
      outdated and carries known advisories
- [ ] Multiple sheets, header rows, merged cells, styles
- [ ] Streamed from the cursor in Phase 23, so a hundred thousand rows does not
      arrive in memory
- [ ] Reusing the existing CSV formula-injection guard and the column allow-list
      pattern from the user export

### Phase 56: Excel import

- [ ] Chunked, and **resumable** from a checkpoint
- [ ] Errors reported per row rather than failing the file
- [ ] All-or-nothing per chunk, so a resume does not double-write
- [ ] Idempotent per row, so a repeated chunk is harmless

### Phase 57: Import presets

- [ ] One descriptor per entity: columns, types, transforms, validation
- [ ] A template download endpoint, which is cheaper than answering "which columns
      do you want?"

### Phase 58: Progress over realtime

- [ ] The import's progress pushed rather than polled, using Group 7

---

## Group 6: Billing

Phases 59–65. An abstraction with Stripe as the default adapter, because a template
hard-wired to one provider gets forked on first contact.

### Phase 59: The provider interface

- [ ] `PaymentProvider` with a capability model, so a provider that cannot refund
      says so rather than failing at runtime
- [ ] No provider named in core

### Phase 60: The Stripe adapter

- [ ] Charges, refunds, subscriptions, and webhook verification
- [ ] Loadable through `loadOptional`, like every other integration

### Phase 61: An internal ledger

- [ ] Double-entry, and **provider data is never treated as the truth**
- [ ] Every state change is ours first and confirmed second

### Phase 62: Reconciliation

- [ ] A polling job that settles what a lost or late webhook missed
- [ ] Idempotent, because it will run again

### Phase 63: Plans, prices and the subscription state machine

- [ ] Explicit transitions; an invalid one is refused rather than coerced
- [ ] Proration, upgrade, downgrade, cancel

### Phase 64: Entitlement to permission

Status: Planned

The highest-value idea in this plan for a boilerplate.

- [ ] A plan grants entitlements; an entitlement maps to a permission
- [ ] The existing `PermissionsGuard` reads it unchanged
- [ ] Without this, billing and authorisation are two separate sources of truth
      about who may do what, and they diverge

### Phase 65: Dunning, refunds and cancellation

- [ ] A failed charge retried on a schedule, then the subscription cancelled
- [ ] Refunds as ledger entries, not as a provider call

---

## Group 7: Realtime

Phases 66–68.

### Phase 66: An SSE gateway

- [ ] Server-sent events first. They cover progress and push notifications, and
      they need no dependency
- [ ] Authenticated in the handshake — no unauthenticated stream, ever
- [ ] Bounded connections per user

### Phase 67: The realtime bus

- [ ] Domain events from Group 4 fan out to subscribers
- [ ] Rooms per user and per tenant, and a tenant never receives another's

### Phase 68: WebSocket

- [ ] Only if SSE is measured to be insufficient
- [ ] Added without a dependency unless that is impossible

---

## Group 8: Reporting and search at scale

Phases 69–73.

### Phase 69: A report registry

- [ ] A report defined as a query plus a format and a schedule
- [ ] Declaring one requires no code

### Phase 70: Scheduled delivery

- [ ] Through the queue, so it retries
- [ ] Delivered by mail or written to storage, whichever the report says

### Phase 71: The OpenSearch translator

- [ ] The **same AST** from Phase 27, a second translator
- [ ] A user's query does not change when the backend does

### Phase 72: Index synchronisation

- [ ] Through the outbox from Phase 52
- [ ] No dual-write, which is where index drift comes from

### Phase 73: A shared facet API

- [ ] Aggregations over the same AST, so search and facets cannot disagree about
      what matched

---

## Group 9: Operations and compliance

Phases 74–79. These close gaps this repository has already written down.

### Phase 74: Backup and restore

Status: Planned

- [ ] A script, and a **restore drill that runs**, not just a backup that exists
- [ ] Measured RPO and RTO
- [ ] `SECURITY.md` tells you to do this before the first deploy and ships no code
      to do it. That is the gap

### Phase 75: Audit tamper-evidence

- [ ] A hash chain over the audit rows
- [ ] An alteration or a deletion becomes detectable rather than invisible
- [ ] Append-only is currently a **convention**: no trigger, no chain, and an
      operator with SQL can rewrite history undetected

### Phase 76: A migration linter

- [ ] Flags a rename or a drop column in one step
- [ ] Expand, backfill, contract is enforced rather than advised

### Phase 77: Fix the `DATABASE_SCHEMA` inconsistency

- [ ] `data-source.ts` reads it; `database.config.ts` does not, so the documented
      env var only works for the CLI and the running app ignores it
- [ ] Both read it, or neither is documented

### Phase 78: The retention policy registry

- [ ] `RETENTION_LOGIN_ATTEMPTS_DAYS` is accepted, validated and does nothing —
      removed or wired
- [ ] Three variables shipped in `.env.example` have no schema validation

### Phase 79: Field-level encryption

- [ ] For the identifiers that are personal data
- [ ] Separately: the two-factor key derivation becomes a work-hardened KDF, and
      the entropy lifecycle gets a second look

---

## Group 10: Developer experience

Phases 80–85.

- [ ] **80** Typed client generation from the OpenAPI document already published
- [ ] **81** `Deprecation` and `Sunset` headers
- [ ] **82** A CI check for OpenAPI breaking changes
- [ ] **83** Seed factories, so fixtures are not hand-written
- [ ] **84** A `docker compose --profile dev` stack: MinIO, Stripe CLI, MailHog, a
      webhook catcher
- [ ] **85** Feature flags, evaluated server-side — a kill switch for the risky path
      is worth more than a rollback

---

## Group 11: Auth expansion

Phases 86–91.

**A boundary worth stating.** These are **core auth protocols**, not integrations.
They are declared as ordinary dependencies in `package.json`, which is a different
thing from the optional-package pattern the integrations use. That pattern exists
so a feature nobody enabled costs zero dependencies; a login method nobody uses is
not the same category, and pretending otherwise either bloats every clone or makes
these look like something they are not.

| Phase | Feature             | Dependency                            |
| ----- | ------------------- | ------------------------------------- |
| 86    | API keys            | **none** — scrypt is already here     |
| 87    | OIDC social login   | declared                              |
| 88    | Passkeys / WebAuthn | declared                              |
| 89    | SAML SSO            | declared                              |
| 90    | Consent records     | none — GDPR record of what was agreed |
| 91    | i18n catalogues     | declared                              |

**Phase 86 is first** because it needs no dependency, the repository already has
the primitives, and it is the foundation for everything machine-to-machine after
it. Keys stored as a scrypt digest with a lookup prefix, scoped like permissions,
and revocable.

The README's optional-integrations wording is corrected to state this boundary
explicitly, rather than leaving a blanket "no dependencies" claim that would be
false once Phase 87 lands.

---

## Group 12: Schema-per-tenant, in full

Phases 92–97.

**The riskiest block in this plan, stated before it is attempted.**

`@InjectRepository` binds a repository from a single `DataSource` when the module
is constructed. Multi-schema is not a config change; it requires a repository
proxy that resolves the right `DataSource` per call through the tenant context,
and that touches how nearly every service obtains its repository.

| Phase | Content                                                                |
| ----- | ---------------------------------------------------------------------- |
| 92    | Repository proxy resolving a `DataSource` per tenant via the context   |
| 93    | A registry that creates, caches and evicts those connections           |
| 94    | A migration runner that runs per schema, reporting progress per tenant |
| 95    | The CLI data source takes a tenant and resolves the schema             |
| 96    | The full e2e suite runs in schema mode                                 |
| 97    | A CI job for it                                                        |

Migration 94 isolates failures: one tenant's schema failing to migrate does not
block the others, because it will eventually, and a migration run that stops at
the first one leaves the platform in a state nobody can reason about.

The `TenantDialect` abstraction from Group 2 is what makes this additive. Row mode
stays the default; `schema` and `database` are further implementations of one
interface, and application code never learns which is active.

---

## Group 13: Testing expansion

Phases 98–101.

- [ ] **98** Contract tests (Pact) for the webhook consumer and the payment
      provider, so changing one does not silently break the other
- [ ] **99** Mutation testing extended beyond auth and retention
- [ ] **100** Load tests for search, export and import
- [ ] **101** Chaos tests: Redis and Postgres failing mid-authentication, because
      the fail-open posture means those paths need to be exercised deliberately
      rather than discovered

---

## Current Execution Rule

One phase at a time, in the order below.

Before starting a phase:

1. Review this plan.
2. Confirm the target phase.
3. Implement only the required files.
4. Run `npm run check`.
5. Commit the phase separately, and add its entry to
   [CHANGELOG.md](CHANGELOG.md).

The order is not arbitrary. Groups 4 to 8 all store data, and they all need a
paging list route and a tenant column that already exists — retrofitting a tenant
column means touching every query, index and unique constraint in the system.
Group 3 precedes Group 4 because the first thing that genuinely needs
retry-until-it-holds is a webhook, and building it before the client discipline
exists means writing the same retry logic twice.

---

## Progress Tracking

| Phase     | Name                                           | Status  |
| --------- | ---------------------------------------------- | ------- |
| Phase 0   | Project Architecture Skeleton                  | Done    |
| Phase 1   | Base Application Foundation                    | Done    |
| Phase 2   | Users Module                                   | Done    |
| Phase 3   | Auth Module - Basic JWT                        | Done    |
| Phase 4   | Authorization - RBAC and Manager Scope         | Done    |
| Phase 5   | Admin Module Foundation                        | Done    |
| Phase 6   | API Documentation                              | Done    |
| Phase 7   | Refresh Tokens                                 | Done    |
| Phase 8   | Device Authentication                          | Done    |
| Phase 9   | Two-Factor Authentication                      | Done    |
| Phase 10  | Cache and Performance                          | Done    |
| Phase 11  | Production Hardening                           | Done    |
| Phase 12  | Optional Integration Foundation                | Done    |
| Phase 13  | Configuration Expansion                        | Done    |
| Phase 14  | Outbound Email                                 | Done    |
| Phase 15  | Background Job Queue                           | Done    |
| Phase 16  | Data Retention and Cleanup                     | Done    |
| Phase 17a | Permission-based Authorization                 | Done    |
| Phase 17b | Authentication and Authorization through Cache | Done    |
| Phase 18  | Notifications                                  | Done    |
| Phase 19  | Account Security Features                      | Done    |
| Phase 20  | Operational Hardening                          | Done    |
| Phase 21  | Testing Depth and Documentation                | Done    |
| Phase 22  | Configurable Email Templates                   | Done    |
| Phase 23  | Cursor pagination                              | Done    |
| Phase 24  | A reusable query criteria object               | Done    |
| Phase 25  | Job progress and cancellation                  | Done    |
| Phase 26  | An audit read surface                          | Done    |
| Phase 27  | A Lucene query parser                          | Planned |
| Phase 28  | The field registry and the translators         | Planned |
| Phase 29  | The Postgres translator                        | Planned |
| Phase 30  | User search                                    | Planned |
| Phase 31  | The search documentation                       | Planned |
| Phase 32  | The tenant column, present from the start      | Planned |
| Phase 33  | The tenant registry                            | Planned |
| Phase 34  | Tenant context                                 | Planned |
| Phase 35  | Repository scoping                             | Planned |
| Phase 36  | Row-level security                             | Planned |
| Phase 37  | Cache namespacing                              | Planned |
| Phase 38  | Per-tenant permissions                         | Planned |
| Phase 39  | Per-tenant mail templates                      | Planned |
| Phase 40  | Per-tenant retention                           | Planned |
| Phase 41  | The isolation proof                            | Planned |
| Phase 42  | A shared HTTP client                           | Planned |
| Phase 43  | Circuit breaker and retry budget               | Planned |
| Phase 44  | Migrate the existing call sites                | Planned |
| Phase 45  | Outbound subscriptions                         | Planned |
| Phase 46  | Signing and replay protection                  | Planned |
| Phase 47  | The SSRF guard                                 | Planned |
| Phase 48  | Delivery                                       | Planned |
| Phase 49  | Inbound webhooks                               | Planned |
| Phase 50  | Service-to-service authentication              | Planned |
| Phase 51  | A domain event catalogue                       | Planned |
| Phase 52  | The outbox pattern                             | Planned |
| Phase 53  | Storage abstraction                            | Planned |
| Phase 54  | Upload validation                              | Planned |
| Phase 55  | Excel export                                   | Planned |
| Phase 56  | Excel import                                   | Planned |
| Phase 57  | Import presets                                 | Planned |
| Phase 58  | Progress over realtime                         | Planned |
| Phase 59  | The provider interface                         | Planned |
| Phase 60  | The Stripe adapter                             | Planned |
| Phase 61  | An internal ledger                             | Planned |
| Phase 62  | Reconciliation                                 | Planned |
| Phase 63  | Plans, prices and subscription state           | Planned |
| Phase 64  | Entitlement to permission                      | Planned |
| Phase 65  | Dunning, refunds and cancellation              | Planned |
| Phase 66  | An SSE gateway                                 | Planned |
| Phase 67  | The realtime bus                               | Planned |
| Phase 68  | WebSocket                                      | Planned |
| Phase 69  | A report registry                              | Planned |
| Phase 70  | Scheduled delivery                             | Planned |
| Phase 71  | The OpenSearch translator                      | Planned |
| Phase 72  | Index synchronisation                          | Planned |
| Phase 73  | A shared facet API                             | Planned |
| Phase 74  | Backup and restore                             | Planned |
| Phase 75  | Audit tamper-evidence                          | Planned |
| Phase 76  | A migration linter                             | Planned |
| Phase 77  | Fix the `DATABASE_SCHEMA` inconsistency        | Planned |
| Phase 78  | The retention policy registry                  | Planned |
| Phase 79  | Field-level encryption                         | Planned |
| Phase 80  | Typed client generation                        | Planned |
| Phase 81  | Deprecation and Sunset headers                 | Planned |
| Phase 82  | OpenAPI breaking-change check                  | Planned |
| Phase 83  | Seed factories                                 | Planned |
| Phase 84  | A development compose profile                  | Planned |
| Phase 85  | Feature flags                                  | Planned |
| Phase 86  | API keys and service accounts                  | Planned |
| Phase 87  | OIDC social login                              | Planned |
| Phase 88  | Passkeys and WebAuthn                          | Planned |
| Phase 89  | SAML SSO                                       | Planned |
| Phase 90  | Consent records                                | Planned |
| Phase 91  | i18n catalogues                                | Planned |
| Phase 92  | Schema-per-tenant: the repository proxy        | Planned |
| Phase 93  | Schema-per-tenant: the DataSource registry     | Planned |
| Phase 94  | Schema-per-tenant: the migration runner        | Planned |
| Phase 95  | Schema-per-tenant: the CLI                     | Planned |
| Phase 96  | Schema-per-tenant: the full e2e suite          | Planned |
| Phase 97  | Schema-per-tenant: the CI job                  | Planned |
| Phase 98  | Contract tests                                 | Planned |
| Phase 99  | Mutation testing, extended                     | Planned |
| Phase 100 | Load tests                                     | Planned |
| Phase 101 | Chaos tests                                    | Planned |
