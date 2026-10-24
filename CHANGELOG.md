# Changelog

Every notable change, newest first, in the order it happened. Entries are grouped
by the commit that made them, carry the task list from the phase that produced
them, and hold the implementation detail that used to live in
[PLAN.md](PLAN.md) before it moved next to the code.

This is a boilerplate, so there is no release history to version. It starts at
`0.0.1` and whatever you build on top of it is yours to version as you see fit.
What matters here is being able to read what a change did and why, without
reading the diff.

The current documentation, describing how the code behaves now, lives next to the
code itself. This file is the record of how it got that way.

---

## feat: migrate outbound HTTP call sites

`feat(http): migrate json-poster and notification channels` ·
`feat(http): migrate password breach lookup to shared client` ·
`fix(http): export http module from http core module` ·
`docs(http): mark phase 44 as done in plan.md and changelog`

**What changed**

- `json-poster` and the three webhook channels (Slack, Telegram, Discord) now
  use `HttpService` from `HttpCoreModule` with all hand-set timeouts removed
- `PasswordBreachService` uses `HttpService` from `HttpCoreModule`, protected
  by a `CircuitBreaker` failing open on persistent outages, with its hand-set
  timeout removed
- `AuthModule` and `NotificationModule` now import `HttpCoreModule` directly,
  and `HttpCoreModule` exports `HttpModule` for consumer injection
- Network errors from `json-poster` and `PasswordBreachService` are classified
  into the `HttpError` taxonomy (`classifyHttpError`)

**Why**

Before this change, each outbound HTTP call site hand-set its own arbitrary
timeout (`5_000`, `2_000`, `this.config.delivery.timeout`) and invented its own
failure handling. Outbound calls now rely on the globally configured timeout in
`HttpCoreModule`, incoming request IDs are propagated on all outbound requests,
and third-party failures are classified into the shared error taxonomy.

---

## feat: outbox pattern

`feat(outbox): add outbox table, service, and entity for dual-write pattern` ·
`feat(outbox): add Outbox entity with aggregate, event_id, payload, and processed tracking` ·
`feat(outbox): add OutboxService with saveEvent, getUnprocessedEvents, and markProcessed methods` ·
`migration: add outbox table with indexes for aggregate, event_id, and processed status` ·
`test(outbox): add basic outbox service structure'`

`feat(domain-events): add domain event key types and data interfaces` ·
`feat(domain-events): add DomainEvent, DomainEventKey, DomainEventData types` ·
`feat(domain-events): add createDomainEvent factory function` ·
`test(domain-events): add 10 unit tests for domain event service`

`feat(service-token): add service token authentication with scopes and short expiry` ·
`feat(service-token): add ServiceTokenService with generate/verify/revoke methods` ·
`feat(service-token): add service token scope constants following permission vocabulary` ·
`test(service-token): add 11 unit tests for service token service`

`feat(tenancy): the request's tenant goes on every statement` ·
`feat(tenancy): inserts inherit the session tenant` ·
`feat(tenancy): queued jobs run in the tenant that enqueued them` ·
`fix(users): stream the tenant-scoped export` ·
`chore(deps): add pg-query-stream for streamed exports` ·
`test(tenancy): one tenant cannot reach another` ·
`ci(tenancy): the suite runs in three modes` ·
`docs(tenancy): phase 41 — the isolation proof`

**What changed**

- The e2e suite runs in three modes: `E2E_TENANCY_MODE=off`, `on`, and `rls`.
  The CI matrix runs all three with `fail-fast: false`
- `TenantScopeSubscriber` puts the request's tenant on the session around every
  statement when `MULTI_TENANT` or `DATABASE_RLS` is on, and resets it after
- `TenantContextService.runAs()` runs queued work in the tenant that enqueued it
- `app_set_tenant_id()` triggers fill `tenantId` from the session for inserts
  that bypass TypeORM subscribers
- `ExportService` scopes its streamed cursor inside its own transaction
- `test/e2e/tenant-isolation.e2e-spec.ts` proves one tenant cannot read, write,
  delete, list, search, export, audit or cache another tenant's data
- `docs/installation.md` has a multi-tenant playground; `docs/production.md`
  describes the request path that now sets the scope

**Why**

Two tenants sharing a database means every query that forgets a filter is a
leak, and a code review cannot prove otherwise. The third mode connects the
application as the `app_user` role the RLS migration creates, so a forgotten
scope returns no rows and a test that depends on one fails. That turns "the
scope looks right" into something CI checks.

**The setting is per statement, not per request.** There is no transaction per
request, and a session setting that outlived its query would be the next
tenant's on a pooled connection. `beforeQuery` sets it, `afterQuery` resets it,
and a `WeakSet` keeps the subscriber's own `set_config` from recursing.

**Inserts get the tenant from the database.** `repository.insert()` and raw SQL
never reach a TypeORM subscriber, and the audit writer, mail log and password
history all insert that way. A `BEFORE INSERT` trigger reads the same session
setting, so the row passes the policy's `WITH CHECK` without every writer
having to name the tenant. With no setting it does nothing, which is what keeps
single-tenant deployments unchanged.

**The export stream is not a query.** TypeORM does not broadcast subscriber
events for a streamed cursor, so the export opens a query runner, sets the
scope transaction-local, streams with `.setQueryRunner()`, and rolls the
transaction back when the cursor is released. The e2e mode also exposed that
`pg-query-stream` had never been installed and the stream path had never run;
it is a dependency now, and the file passes through the response interceptor
instead of being wrapped as JSON.

**Every request in the suite carries the default tenant.** The harness adds the
header when multi-tenancy is on, so the existing specs keep testing what they
were written to test rather than turning into 401s; a spec about tenants sets
its own header afterwards.

---

## feat: retention cleans one tenant at a time

`feat(tenancy): a retention run cleans one tenant` ·
`feat(tenancy): the retention job visits every tenant`

**What changed**

- The retention job visits every tenant, and each run is scoped to its own
  tenant
- The run's predicate filters by the tenant, and the run sets
  `app.tenant_id` inside the transaction
- `maintenance_logs` history and the latest run are tenant-scoped

**Why**

Retention removes rows by age, and a row that is expired for one tenant is
another tenant's live one. A single run over every table would clean them
together.

**Both halves of the scope are set, because they are not the same half.** The
`WHERE` clause is what the run intends; `set_config('app.tenant_id', ...)` is
what the database will let it see. A run that never set the scope would match no
rows at all, and would report a clean table it had not touched.

**The scope is set inside a transaction, because it is transaction-local.**
`set_config(..., true)` is undone by the commit, and a session-level setting
would outlive the tenant it was set for.

**The history is one tenant's.** The numbers in it are the ones that decide
whether the data is being cleaned.

**A disabled tenant is not visited.** Housekeeping that reached a disabled
tenant would touch data an operator has asked to leave alone.

---

## feat: a mail template belongs to the tenant that wrote it

`feat(tenancy): a mail template belongs to the tenant that wrote it` ·
`test(tenancy): one tenant's template is not another's`

**What changed**

- The template read, the write, the history and the reset filter by the tenant
- The process-local compiled template cache is keyed by the tenant as well

**Why**

An override of a shipped template is one tenant's wording, and it is not another
tenant's to send: a password reset with the wrong tenant's support address is
one customer's words landing in another customer's inbox.

**The shipped file stays the fallback.** A tenant with no override of its own
renders exactly what it rendered before, which is what keeps the phase
additive.

**The compiled cache is scoped by hand.** The distributed cache needs nothing —
`CacheService` folds the tenant into every key it is given — but the compiled
templates are a plain map in this process, and the compiled form is a function
of the source, which is the tenant's own.

---

## feat: a role holds different grants in different tenants

`feat(tenancy): a role holds different grants in different tenants` ·
`feat(tenancy): the catalogue is seeded into every tenant`

**What changed**

- The permission read, the catalogue, the write and the bulk read filter by the
  tenant
- The seeder clones the catalogue into every tenant rather than writing one
  global copy
- `PUT /admin/roles/:role/permissions` is tenant-scoped, by being the same
  route

**Why**

The same role name in two tenants is two different sets of grants. Without this,
a tenant's admin role would answer with the grants of whichever tenant seeded
last.

**The catalogue is cloned, not shared.** The unique index on
`(tenantId, name)` is what says a permission name belongs to one tenant, and the
seed walks the tenant registry for that reason: a permission introduced in code
reaches every tenant on the next seed.

**The tenants are seeded first.** A catalogue cloned into nothing is a
deployment whose users hold no permission, and the fixed default tenant is the
one every row written before the registry existed belongs to.

**The seed evicts the keys the service would have written.** The seed talks to
the raw store rather than to the cache service, so it has to build the key the
service builds — tenant in front and all.

**The key is `<tenantId>:role:<role>`, and the plan said `role:<tenantId>:<role>`.**
The cache service folds the tenant into the key prefix in one place, and the
role key is built on top of that, so the tenant comes first. The plan's
spelling is the one a key has when nothing scopes it.

---

## feat: the tenant is folded into the cache key, in one place

`feat(tenancy): the tenant is folded into the cache key, in one place` ·
`test(tenancy): two tenants cannot reach the same entry`

**What changed**

- `src/core/cache/cache.service.ts` — every key carries the tenant, including
  the read-through wrapper
- A spec asserting that two tenants' entries cannot collide

**Why**

A key without a tenant is a key two tenants can reach, and the second one to ask
is served the first one's answer. The tenant is folded in by the cache service
rather than by the call sites, because a call site that had to remember it would
be the one that forgot it.

**The wrapper is scoped too.** It coalesces concurrent misses against a key of
its own, so leaving it alone would have meant a delete that did not delete.

**Work outside a request still caches, under the default tenant.** A seed, a
scheduled job and a migration are not inside a tenant's context, and refusing
to cache them would be a strange thing for a cache to do.

---

## feat: row-level security, as the layer underneath

`feat(tenancy): row-level security, enabled and forced` ·
`feat(tenancy): the policy, on every table` ·
`feat(tenancy): the application role is not a superuser` ·
`feat(tenancy): the tenant scope on the connection` ·
`test(tenancy): the policy binds`

**What changed**

- `src/database/migrations/1792800000000-AddRowLevelSecurity.ts` — the policies
  on all seventeen tables, and the `app_user` role
- `src/common/tenancy/tenant-scope.ts` — `setTenantScope()`

**Why**

RLS is not a replacement for the repository scope; it is the layer underneath.
An application bug that forgets the filter gets an empty result rather than
another customer's data.

**`FORCE ROW LEVEL SECURITY` is on every table.** Without it the table owner
bypasses the policy, and TypeORM connects as the owner.

**`WITH CHECK` on every policy, so an insert cannot write into another
tenant.** A policy that only reads is a policy that guards the wrong direction.

**The application role is not a superuser**, because a superuser bypasses every
policy — which would make the whole layer a comment.

**The setting is transaction-local, and only the retention run sets it.** The
request path does not, so the policies bind for the paths that set the scope
and the repository scope is what holds the line on the others — which the
production notes say out loud rather than leaving to be discovered.

---

## feat: a repository that only ever sees one tenant's rows

`feat(tenancy): a repository that only ever sees one tenant's rows` ·
`test(tenancy): a repository method without a scope fails the suite`

**What changed**

- `src/common/tenancy/tenant-scoped.repository.ts` — the base class that applies
  the scope on every read and write
- A spec that lists the public methods, so a method added without a scope fails

**Why**

A query that has to remember the tenant is a query that will forget it. The
scope lives in one place, and the spec fails when a new public method appears
without one, which is the only way the guarantee survives the next person.

---

## feat: the tenant context

`feat(tenancy): the tenant context` ·
`feat(tenancy): a request runs inside its tenant` ·
`feat(tenancy): a job carries its tenant`

**What changed**

- `src/common/tenancy/tenant-context.service.ts` — the context on
  `AsyncLocalStorage`
- The middleware sets it before the guard runs
- `Job.tenantId` is required, and both dispatchers stamp it

**Why**

A job with no tenant context is a job that writes in the wrong place, so the
tenant travels with the job rather than being looked up when it is processed.
The field is required on the type, so a job that does not carry one does not
compile.

**The scope ends with the work.** A callback that outlived the request would
keep the tenant alive, and the work would be done in a context that says
something that is no longer true.

**A tenant that had to be passed to every service would be passed to every
service that remembered**, and the one that forgot would read another tenant's
rows. The context is the only version of this that cannot be forgotten,
because nothing has to carry it.

---

## feat: the tenant registry

`feat(tenancy): the tenants table` ·
`feat(tenancy): the tenant registry` ·
`feat(tenancy): a request is resolved to a tenant` ·
`feat(tenancy): the fixed tenant row is seeded`

**What changed**

- `src/modules/tenancy/entities/tenant.entity.ts` — the `tenants` table: slug,
  name, status, plan and `schemaName`
- `src/modules/tenancy/tenant-registry.service.ts` — the lookup: by slug, by
  id, and the default tenant
- `src/modules/tenancy/tenant.middleware.ts` — the resolution, and the 401s it
  answers with
- `src/database/migrations/1792700000000-AddTenantsTable.ts` and a seeder that
  writes the fixed default row

**Why**

A tenant is a row rather than a setting, because the day a deployment serves
more than one, an operator has to be able to see them, disable one and give one
a plan — and none of that is possible with a constant.

**Resolution is header first, host only when a base domain is configured.** The
header is explicit; the host is inferred, so it is only used where the
deployment has said what its hosts look like.

**An unknown or disabled tenant is a 401, never a fallback.** Falling back to
the default tenant would answer a request for another customer's data with
this deployment's rows.

**The default tenant is a constant and is not looked up.** The feature being
off must not depend on a row existing: a database that has not been seeded
still has to answer a request. The seeder writes the row so that an operator
can see it, and it carries the same id the column's default does — which is
what makes the feature switchable without a backfill.

---

## feat: the tenant column on every table

`feat(tenancy): the default tenant and the tenancy config` ·
`feat(tenancy): the tenant column on every table` ·
`feat(tenancy): a natural key is unique inside its tenant` ·
`feat(tenancy): an index leads with the tenant` ·
`test(tenancy): the tenant column, checked on every table`

**What changed**

- `src/common/tenancy/tenant.constants.ts` — `DEFAULT_TENANT_ID` and the header
  name
- `src/configs/tenancy.config.ts` — the `tenancy` namespace: `enabled`, `header`
  and `defaultTenantId`
- `tenantId` on all seventeen tables, `NOT NULL` with the fixed default
- The natural keys are composite — `(tenantId, email)`, `(tenantId, name)`,
  `(tenantId, role, permissionId)` — and every b-tree index leads with the
  tenant
- `src/database/migrations/1792600000000-AddTenantColumn.ts`, and a spec that
  checks every entity, the composite uniques and the index order

**Why**

The column is present from the start rather than added when the feature is
switched on, because a tenant column added afterwards means touching every
query, every index and every unique constraint again — and the ones nobody
remembers are the ones that let two tenants share a row.

**A fixed default, so the feature is switchable without a backfill.** The
default is a constant rather than a lookup, so a database that has not been
seeded still answers, and `MULTI_TENANT=false` behaves exactly as it did.

**An address is only unique within a tenant.** A unique key on the address
alone would stop the second tenant from having an account with an address the
first one already has, which is the whole point of having more than one tenant.

**Every index leads with the tenant.** A lookup that filters by tenant and then
by something else needs the index to be in that order, and an index that does not
lead with the tenant is one that serves one tenant's query at another's cost.

---

## docs: the search documentation

`docs(search): the search layer's documentation` ·
`feat(search): sort the search by the fields that may be sorted`

**What changed**

- `src/common/search/README.md` — the layer's document: the field type table, the
  three capabilities, the weight, how to register an entity, a worked example,
  the derived field and the anti-patterns
- `src/common/search/worked-example.spec.ts` — the README's claims, checked
- `POST /users/search` takes a `sort` and an `order`, and the registry's
  `sortable` flag is what says which fields may be sorted by

**Why**

The machinery worked and nobody could use it, because the thing that makes a
layer reusable is not the code — it is the document that says what the pieces
mean and what to do when the entity is not a user.

**The document is the phase, and a spec is where its claims are checked.** A
documentation file nobody runs drifts; a spec cannot. The same reasoning as the
query layer's `adding-a-route.spec.ts`, which adds a route that does not exist.

**The worked example is an entity of a different shape** — a uuid, money as an
integer, a keyword and a date — so the machinery is shown on something that is
not a user. The two decisions in it that are the entity's and not the layer's
are said out loud: the amounts are in cents so the arithmetic is exact, and a
customer address is worth more in a search than a status is.

**A derived field is the database's job.** A full name built from a first name
and a last name is a _generated_ column, so the application keeps no second copy
of it — and `name:john` works because the derived column is one of the map's
searchable fields and the document is built from those. The cost is stated: the
full name is in the document as well as its parts, so a customer called John
Smith ranks above one called John, which is usually what a search for a name
means.

**The anti-patterns say what happens, not only what not to do.** A leading
wildcard has no index to use, the wildcard `*` matches every row, a facet over a
text field is a group per row, and a fuzzy term is refused because postgres has
no edit distance without an extension.

**The three capabilities are refusals as much as permissions.** A field that is
not searchable is refused rather than quietly matching nothing, because "no such
user" and "you may not search that field" look identical from the outside and
mean opposite things.

**One thing the documentation had to make true.** The `sortable` flag was
declared in the field map and read by nothing, which is a plan rather than a
feature. The search takes a `sort` now, and a field that is not sortable is
refused rather than sorted by a query nobody designed. The two maps that
describe one entity — the listing route's query spec and the search's field map
— are compared by a spec, so a field that is sortable in one and not the other
cannot drift.

**What it gives up**

- The examples are on a fictional entity, so nothing proves the _users_ search
  behaves the way the example does. The e2e suite proves the users search, and
  the example proves the machinery.
- The anti-patterns are documented rather than refused. A leading wildcard is
  legal and slow, and a refusal would be a decision about one entity's index
  rather than about the language.

**Carried into Phase 32**

The tenant column. A search over a table that will hold several tenants' data
has to be scoped to one, and the scope has to be the repository's rather than
the query's — a search is a query, and a query that can be pointed at another
tenant's rows is a question nobody asked for the answer to.

---

## feat: the user search route

`feat(users): the search route`

**What changed**

- `POST /users/search` — the best matches for a query, and the counts of the
  matching rows per facet
- `src/modules/users/dto/user-search.dto.ts` — `UserSearchDto`, `UserSearchHitDto`,
  `FacetCountDto` and `UserSearchResultDto`
- `UsersService.search()` and the facet count
- The search errors are now HTTP exceptions, so a malformed query is a 400
- `toRawQuery` in the search layer, for the one query that is run raw

**Why**

There was a query language, a field map and a translator, and nothing that used
them. So the search was a library rather than a feature.

**A body rather than a query string.** A search is a sentence somebody typed, and
a sentence has spaces, quotes, brackets and colons in it — all of which have to
be escaped in a URL and all of which are wrong in one. The body also has room
for the facets, which do not fit in a path.

**Gated on `user:read`,** the permission to read a user record. The search reads
user records and finds them by name, and the permission that says a caller may
read a user record is the one that says they may find one. It is the first
route that checks it, and the grant was already there.

**Not idempotency-keyed, because it changes nothing.** The guard is for writes —
a request that creates a second thing — and a read that asked for a key would
make every search box carry a header it has no reason to send.

**The results and the counts come from the same filter,** so the two cannot
disagree about what matched.

**No cursor.** A ranked set is not keyset-paged on a column, because the rank is
not a column: a boundary on a floating-point score is a boundary that can be
equal or not by a rounding error, and a page that repeats a row or skips one is
worse than a search that says "here are the best twenty". A client that needs a
specific set filters instead — the filters are exact, and `GET /users` pages over
a column.

**The search errors are 400s.** A malformed query is a client mistake, and a
client mistake must be a 400 that says which part was wrong and where. A
`TypeError` from inside the parser is a 500 for a request that was merely wrong.
The alternative was a list of error classes at every route that searches, and a
route that forgot the list would answer a 500 for a typo.

**The facet's value is cast to text,** so a client does not have to know whether
the field it asked for is a string, a number or a boolean. The grouping is on
the column rather than on the cast, so the index on it can still be used.

**The raw facet query needed its placeholders rewritten.** TypeORM's query builder
binds `:p0` and its raw call goes straight to the driver, which takes postgres's
`$1`. The rewrite touches only the placeholders — the values stay parameters —
and it leaves a cast alone, because postgres writes a cast as `::` and the second
colon is not a placeholder. The e2e suite caught that one: the first version
rewrote `count(*)::int` into a parameter and the query failed with an error
about a parameter rather than about the mistake.

**The e2e suite proves it against a real database.** Two users, one of whom
matches, and the search finds that one and not the other — and refuses an
unknown field, an unparseable query, an ordinary user and a caller with no
token at all.

**What it gives up**

- There is no page after the first. A ranked set is not keyset-paged on a
  column, and a client that needs a specific set filters instead.
- A facet over a text field is a group per distinct text, which is a group per
  row. The fields worth faceting are the ones with a small number of values.
- The search returns the whole row, so it is as much personal data as
  `GET /users/:id` — which is why it is behind the same permission.

**Carried into Phase 31**

The search works on one entity, and the machinery is meant to work on any. What
is missing is the document: the field types, the three capabilities, and how to
register an entity whose shape is different.

---

## feat: the postgres translator

`feat(search): a tsquery built from the tree` ·
`feat(search): the document column, the gin index and the migration` ·
`feat(search): facet counts over the same tree`

**What changed**

- `src/common/search/translators/full-text.ts` — `translateToFullText`, which
  turns a tree into a filter and a rank, and `buildDocumentExpression`, which
  turns a field map into the expression that fills the document
- `src/common/search/translators/facet.ts` — `translateToFacet`, the counts of
  the matching rows grouped by one field
- `src/modules/users/users-search.ts` — `USER_SEARCH_FIELDS`, the six fields a
  user can be searched by and the weight each one carries
- `src/modules/users/entities/user.entity.ts` — the `searchVector` column and
  the GIN index over it
- Migration `1792500000000-AddUserSearchVector`
- `SearchFieldRegistry` gained the document column

**Why**

The tsquery was the one piece of the language that had nowhere to go: a parser
that produced a tree, and a translator that turned the tree into column
comparisons. A word search — the thing a search box is for — was not
expressible.

**The terms are parameters and the operators are ours.** A term goes in as
`plainto_tsquery('simple', :p0)` and a phrase as
`phraseto_tsquery('simple', :p0)`, and the `&&`, `||` and `!!` between them are
written by the translator. Those two functions are the ones that do **not** read
their argument as an expression, so a term containing `&` or `|` or `!` is text
and never becomes an operator. `to_tsquery` would have been the obvious choice
and it is the wrong one: it parses its argument, so a term could add a clause to
the query.

**The filter and the rank are separate.** The filter says which rows match; the
rank says which of them came first. The rank is `ts_rank(document, tsquery)`,
with the boost multiplying it, because postgres ranks a whole match rather than a
clause.

**The filter is one walk, not two.** The text clauses and the other clauses
cannot be split into two parallel trees and combined afterwards, because `NOT`
does not distribute: `NOT (a AND b)` is not `NOT a AND NOT b`.

**The document is generated, so it cannot drift.** A column filled by a trigger
is a column that can be wrong — the trigger misses, the write is rolled back,
the trigger is disabled for a moment — and a search index that is wrong is worse
than no index, because it answers "no such user" for a user that exists. A
generated column is computed by postgres on every write, so it is the row's own
text by construction.

**The expression is written in three places and the three are compared.** The
field map, the entity and the migration each say what the document holds, and a
spec compares the expression the map builds with the other two. A weight that
changed in one of them and not the others would make the ranking quietly wrong —
a match on the address ranking below a match on the name — and nothing would say
so, because the search would still work and still return the right rows.

**The weights are chosen, not defaulted.** The address is what a person
identifies an account by, so it is A. The two names are B. The role is C,
because it is a word about the account rather than a name for it. The active flag
and the creation date are filtered and sorted but never searched.

**Only the searchable fields are in the document.** A password hash in the
document would be searchable, and a document is exactly what a search box reads.
The spec caught that one.

**The facets count the rows the results show.** The facet carries the very same
filter, so the counts and the list cannot disagree about what matched.

**The configuration is `simple` and not `english`,** because the english one
stems and drops stop words: a search for "users" would not find "user". It is a
literal, because a generated column's expression has to be immutable and
`to_tsvector(regconfig, text)` is only immutable for a literal configuration.

**What it gives up**

- **One document per entity means a field-scoped term matches the document.**
  `email:ada` also matches a row whose _name_ contains "ada", because the
  weights decide the order of the results, not which rows match. A search that
  needs a field's own text needs its own column, and that is one column and one
  index per field.
- A wildcard has no tsquery, so it is a pattern match on the column and it is
  unindexed.
- A fuzzy term is refused, as it is in the filter translator: postgres has no
  edit distance without an extension, and a trigram similarity is a different
  function.
- A boost multiplies the score of the whole match, because postgres ranks a
  match rather than a clause.

**Carried into Phase 30**

There is a searchable `users` table and a translator that can ask it a question.
What is missing is the route: the permission, the body, and the shape of the
answer.

---

## feat: the field registry and the translators

`feat(search): the field registry, which is the allow-list` ·
`feat(search): the in-memory translator, which is the reference` ·
`feat(search): the postgres translator` ·
`feat(search): a mock translator and the test kit every search uses`

**What changed**

- `src/common/search/field-registry.ts` — `SearchFieldRegistry`, and the six
  facts a field has: its type, whether it can be searched, filtered or sorted,
  its weight, and the column it lives in
- `src/common/search/translators/postgres.ts` — `translateToSql`, which turns a
  tree into SQL and the values to bind with it
- `src/common/search/translators/in-memory.ts` — `translateToPredicate`, which
  turns a tree into a question about one row
- `src/common/search/translators/mock.ts` — `MockSearchTranslator`, for testing
  the caller rather than the translation
- `src/common/search/search.test-kit.ts` — the golden cases, the fuzz corpus, the
  injection corpus, and the assertions over them
- `UnknownFieldError`, `UnsupportedFieldError`, `UnsupportedOperationError` and
  `InvalidSearchValueError`

**Why**

The parser knew a field was a name; nothing knew what the names meant, so a
query could name anything and there was nowhere to say which fields exist.

**The allow-list is the injection boundary.** A field name is the client's
input, and the only way it can reach SQL is by being looked up in the registry
first. An undeclared name is an `UnknownFieldError` that lists the names that do
exist — never a field silently dropped, because a dropped field is a filter the
client believes is applied and is not.

**The column is the one piece of a search that becomes SQL text.** Everything
else is a parameter, and a parameter cannot change the meaning of a statement.
An identifier cannot be bound, so the column is interpolated — and so the
registry refuses a column that is not a plain identifier. A field map that
accepted `"email" ; DROP TABLE users` would be a field map that had handed a
client the database, and the check is what makes that impossible rather than
unlikely. The alias is checked the same way, because it is interpolated too.

**Every value is a parameter, and it is converted to the field's type first.** A
range over numbers compares numbers and a range over dates compares timestamps.
A value that is not a number is refused here rather than by postgres — which
would answer with an error about a type it cannot coerce, and the client would
be told about a type rather than about the value they typed.

**The type decides whether a term is a match or a comparison.** A text field is
matched as a substring and has to be searchable; every other type is compared
for equality and has to be filterable. One rule, and the flag that matters
follows from the type rather than being a second thing to get right.

**A one-word phrase on a field that is not text is that word.** A keyword is
one value and a date is one value, and a quoted value is how a value with a
colon or a space in it is written — so `createdAt:"2026-01-01T00:00:00Z"` is an
equality. More than one word is refused: "the words of a number" is not a
question.

**The in-memory translator is the reference.** It answers "which rows match"
with nothing but JavaScript, so the answer can be checked by hand, and a
Postgres translator that disagrees with it is answering a different question.
It also implements the fuzzy term exactly, which the SQL path refuses: postgres
has no edit distance without an extension, and a trigram similarity is a
different function.

**The kit's golden cases are derived from the registry, not written down.** The
fields differ between entities, and a case that named one of them would be a
case about that entity rather than about the search. The cases that come out are
a term and a range on every field the field map declares.

**The kit asserts rather than registers.** It throws on a failure and a spec
calls it from an `it`, so the file ships in the build carrying no dependency on
a test framework. Its own spec breaks each of the properties on purpose to show
that the kit notices — a kit that cannot fail is a kit that proves nothing.

**The injection corpus holds every command that changes data.** Not the two that
are famous: a filter that blocks `DROP TABLE` and lets `UPDATE users SET role =
'super_admin'` through has not blocked anything, and the payload that changes a
row is just as short as the one that drops a table. So the corpus carries
insert, update, delete, merge, upsert, copy, create, alter, drop, truncate,
grant, revoke, execute, call, do, set, vacuum, reindex, cluster, refresh,
reassign, comment, security, lock, checkpoint, discard, the transaction
statements, prepare and deallocate, listen and notify, analyze, import and
load — plus the read-only ones, because a statement that reads somebody else's
password is nearly as bad as one that changes a row.

**And the fragment is a predicate, never a statement.** The corpus proves the
payloads somebody thought of; this holds for the ones nobody did. A translated
fragment may contain a column name, a parameter, a comparison and a boolean
operator, and nothing else — a word outside that vocabulary is a statement, and
a semicolon is how a second statement begins. The translator emits a boolean
expression over columns and parameters, so there is no shape an input could take
that would make it a statement.

**What it gives up**

- The weight and the boost are declared and carried but not applied by either
  filter translator. A boost and a weight change the order of the results, not
  which rows match, and the ranking is Phase 29's.
- The SQL path refuses a fuzzy term and the in-memory path implements it. The
  two differ in that one respect, on purpose, and the difference is documented
  in both files.
- There is no derived field yet — one that is not a column, like a full name
  built from a first and a last. It needs a way to read the value that is not
  there, and that is Phase 31's addition to the descriptor.
- A value with a colon in it has to be quoted or escaped: `createdAt:2026-01-01T00:00:00Z`
  is a field followed by a term and a colon, because a colon separates a field
  name from a value.

**Carried into Phase 29**

The translator now knows how to say "these rows match" and never says it with
anything but a parameter. What is missing is the other half: the ranking, the
`tsvector` column, the facet counts — and the weight and the boost, which are
declared and waiting for it.

---

## feat: a lucene query parser

`feat(search): a lucene query parser that knows no entity`

**What changed**

- `src/common/search/ast.ts` — the eight shapes a parsed query can take:
  `MatchAllQuery`, `FieldQuery`, `PhraseQuery`, `WildcardQuery`, `ExistsQuery`,
  `RangeQuery`, `BoostQuery`, `BooleanQuery`
- `src/common/search/tokenizer.ts` — the words, the phrases, the ranges, the
  comparisons, and the escapes
- `src/common/search/parser.ts` — recursive descent, one method per precedence
  level
- `src/common/search/errors.ts` — `SearchParseError`, with the position in the
  query
- `src/common/search/parser.spec.ts` and `tokenizer.spec.ts`

**Why**

There was no way to express a search, so every list route had a filter set
written for it and a search box would have meant one route per question. One
query language, written once, read by every searchable entity.

**The parser knows no entity.** A field is a name in the tree and nothing more:
which column it lands on, whether it may be searched at all and what it weighs
are the field registry's business, and the registry is Phase 28. Nothing in
`common/search/` mentions a column, a table or a weight — and that is what makes
adding search to `customers`, `orders` or `invoices` one field-map file and no
new infrastructure.

**The grammar is one method per precedence level.**

```text
or      := and ( OR and )*
and     := not ( AND? not )*
not     := NOT not | primary
primary := '(' or ')' | field-value | term | phrase
```

`NOT` binds tightest, then `AND`, then `OR`.

**The tree is a binary tree, not `must`/`should`/`mustNot`.** The flat shape
carries a rule that is easy to get wrong — a `should` clause is optional only
when there is no `must` — and a translator that flattens the two answers a
different question from the one asked. `a AND (b OR c)` means `a AND (b OR c)`,
not `a AND b`. A binary tree makes the grouping explicit in the shape itself, and
every node is a self-contained boolean over two clauses.

**The operator between two adjacent terms is AND, where Lucene's classic parser
defaults to OR.** A deliberate deviation, and the reason is what this language is
for: this is a filter over a table somebody is typing into, and a query that
widens with every word returns the whole table and leaves the filter to the
operator. `OR` is available explicitly, so nothing is lost.

**The tokenizer does not decide what a word means.** `AND`, `email` and `mail*`
are the same kind of token; only the parser knows which is which, because only
the parser knows whether it is reading an operand or a value. A tokenizer that
decided on its own would have to guess, and the guess would be wrong for
`field:AND` — a search for the word "and" in a field, which is a term.

**The keywords are uppercase.** `and` is a term; `AND` is an operator. The same
rule Lucene uses, and the reason the word "and" is searchable at all.

**The three refusals are refusals, not omissions.** Not because the three are
hard — because a translator that has to produce one of them cannot be proved to
produce the thing the user asked for, and a search that answers a different
question is worse than one that says it cannot.

- **Regular expressions** (`/foo/`). A regex is a different question from a
  term, and treating one as the other searches for the text `/foo/` and finds
  nothing. Lucene's own rule decides what counts as one — a term that opens and
  closes with a slash and holds no other slash — so `/api/v1` is still a path.
- **Scripts and pseudo-fields** (`_script:x`). A translator cannot produce a
  computed field, and a leading underscore is how Lucene and Elasticsearch name
  one.
- **Nested queries** (`title:(a OR b)`). A group inside a value is a query
  inside a query.

**The parser is total.** Every input produces either a tree or a
`SearchParseError` — never a `TypeError`, never a hang. A malformed query is a
client mistake, and a client mistake must be a 400 that says which part was wrong
and where; a `TypeError` from inside the parser is a 500 for a request that was
merely wrong, and one that loops is a denial of service.

**The errors carry the position.** "at position 14" is actionable and "invalid
query" is not.

**What it gives up**

- A star in a term is always a wildcard, escaped or not, because the tokenizer
  resolves the escapes before the parser sees the text. A phrase is how a
  literal star is written — everything inside quotes is literal, which is also
  Lucene's rule.
- The edit distance is 0 to 2, Lucene's own limit. A distance of three is a
  match against almost anything, which is a query that returns the table and
  looks like a filter.
- A range's bounds are text, not numbers. A range is over a date, a number or a
  keyword, and which one it is depends on the field — so the parser does not
  convert, and the translator binds the text as a parameter of the column's own
  type.
- There is no way to write a query against a computed value. That is the
  script refusal, and it is deliberate.

**Carried into Phase 28**

The tree is the contract, and the registry is what makes it translatable: a field
name becomes a column, a type and a weight, and an undeclared field is an error
rather than a silent no-match. The parser has already refused the shapes that
would make a translator unprovable — a regex, a script, a nested query — so the
translator's job is the mapping and nothing else.

---

## feat: an audit read surface

`feat(audit): a read surface for the trail`

**What changed**

- `GET /admin/audit` — a page of the trail, filtered by actor, action, target,
  outcome and window, cursor paged
- `src/modules/audit/audit-query.ts` — `AUDIT_QUERY_SPEC`, the route's whole
  query surface in one object
- `src/modules/audit/dto/audit-query.dto.ts` — `AuditQueryDto`, and the two
  closed sets (`actorType`, `outcome`)
- `src/modules/audit/dto/audit-log.dto.ts` — `AuditLogDto`
- `AuditService.list()` — the one call the route makes
- `Permission.AuditRead` (`audit:read`), held by the super administrator alone
- `test/e2e/audit-read.e2e-spec.ts` — the acceptance criterion, over the wire

**Why**

The trail was written for every privileged action and no route returned it.
Answering "show me every `users.update` on this account" meant leaving the
application and writing SQL, which is the one thing an incident responder should
not have to do while the incident is happening.

**The query surface is one object.** `AUDIT_QUERY_SPEC` says which fields may be
filtered and which column each one means; `AuditQueryDto` says what the request
may contain; the two are checked against each other at compile time in both
directions. A filter the DTO does not declare could never arrive — the global
validation pipe strips a parameter the DTO does not name — and a DTO property no
filter declares is a parameter the client can send and the route ignores. A
client that asks for the failures and gets every row has been told a lie.

**Every value is bound.** The action, the target and the window are parameters;
the column names come from the spec and never from the request.

**The window is two bounds, and the offset is required.** `from` is `>=` and `to`
is `<=`, and the request says _what_ to filter by and never _how_: a client that
could pick the operator could pick the one that makes the window mean something
else. A timestamp without a timezone is refused rather than interpreted, because
it means different instants on two deployments and both answers are correct.

**The action is matched exactly.** The action names are a closed vocabulary — one
per privileged route, asserted by `audit-policy.spec.ts` — and "every
`users.update`" is not "every action containing the text `users.update`".

**The actor's address is matched as a substring**, the same way `GET /users`
matches its email, so a client can search from the domain side. It is a snapshot,
so it matches the address the actor had at the time rather than the one they have
now.

**Who may read it, and why that is a decision rather than a default.**
`audit:read` is held by the super administrator alone. Not because the trail is
dangerous to look at — an administrator already holds `UserRead`, so the personal
data in the snapshots is not new to them — but because of _who_ it describes:
every privileged actor, with the failures included, because a refused request is
evidence.

**The manager gate cannot be the thing that decides it.** `isManager` is a
column an administrator can set on any account through `PATCH /users/:id`, so a
route gated on it can be widened by the very people it reports on. The cost is
stated rather than hidden: an ordinary administrator investigating an incident
needs an escalation.

**The read fails where the write does not.** `record()` never throws, because an
outage in the log must not become an outage in the product. A read that failed
and answered "no rows" would be a lie an investigator would act on: "nobody
touched this account" and "the database was down" look identical until somebody
checks the logs. So the read propagates the failure.

**Reading the trail does not write to it.** A read that wrote to the trail would
make it grow every time somebody looked at it, and every investigation would
add an entry about the investigation. `audit-policy.spec.ts` asserts it.

**What it gives up**

- There is no list of the actions, so a client cannot discover what a filter
  value should be. The vocabulary is in the audit policy, and the audited routes
  are six.
- The trail is read a page at a time and the page is newest-first. An
  investigation that wants the oldest entry walks to the end of the walk.
- `before` is still always null on an interceptor entry, so the prior state is
  still unrecoverable from the trail alone. That is gap 3 in the audit module's
  own list, and this phase does not close it.
- The trail has no tamper-evidence. Append-only is a convention, and an operator
  with SQL can rewrite history undetected. That is Phase 75.

**Carried into Phase 27**

A search over a table with free text is a different problem from a search over a
fixed vocabulary, and the parser Phase 27 builds is for the first kind. The
audit trail is the second kind, and it is now served by a declared filter set
rather than by a query language — which is the right shape for it.

---

## feat: job progress and cancellation

`feat(queue): give every job an id and keep its progress` ·
`feat(queue): let a job report progress and be stopped`

**What changed**

- `src/modules/queue/job-progress.service.ts` — where a job's progress is kept,
  and where a cancellation is registered
- `src/modules/queue/job-id.ts` — the id a job is known by
- `src/modules/queue/jobs.controller.ts` — `GET /jobs/:id` and
  `POST /jobs/:id/cancel`
- `src/modules/queue/dto/job-progress.dto.ts` — the two response shapes
- `JobRequest` and `Job` split in `queue.interface.ts`: the caller submits a
  request, the queue mints an id and the processor receives a job
- `JobContext` — what a processor is told: report how far you have got, and find
  out whether you should stop
- `JobResult.cancelled` — a fourth outcome, beside success, failure and
  permanent failure
- Both dispatchers record the lifecycle: queued, running, completed, failed,
  cancelled
- The retention run reports its progress and checks for a cancellation between
  batches
- `Permission.JobRead` (administrator and super administrator) and
  `Permission.JobCancel` (super administrator alone)
- `QUEUE_PROGRESS_TTL`, default 86 400 000 ms
- Migration `1792500000000-AddMaintenanceCancelled`: a `cancelled` column on
  `maintenance_logs`
- `RedisClientService.inspect` — a read that tells "absent" from "unreachable"

**Why**

A job was unnameable. `enqueue` took a job and returned nothing, so there was
no handle to ask about a job with and nothing to say to one that was taking too
long. A five-minute import had to be waited out.

**A job has an id, and the queue mints it.** The queue rather than the caller,
so a job cannot be queued without one and two replicas cannot mint the same one.
It is a uuid because the id is in a URL and in a log line, and a counter would
let one operator read another operator's job by walking the numbers.

**The progress lives in redis, not in a table.** It is live state about work
that is happening now, it is read by a person watching a run, it is worthless a
day later, and nothing joins against it. A table would mean a schema, a
migration, a row per report and a retention rule for a table whose whole content
is "how far along was that, and it finished two hours ago". Redis is already
here, its keys are namespaced away from the cache, and the TTL is the cleanup —
the store deletes the record, so nothing has to be scheduled to.

**The cancel flag is a separate key from the progress.** The two have different
writers: the flag by the process serving the route, the progress by the worker.
One key with two writers is a key where one of them eventually overwrites the
other.

**The route gives three answers, not two.** A missing job is a 404 and an
unreachable store is a 503. They are different facts, and collapsing them tells
an operator their job does not exist while it is running. That needed one new
method on the redis client, because `get` answers `null` for both a miss and an
outage — and both of those are the right answer for a caller that treats a miss
and an outage the same way, which the deduplication guard does.

**Nothing in the store is allowed to fail a job.** Every write is best effort and
the failure is swallowed, because the alternative is a redis outage turning into
a queue that drops mail.

**A cancellation is a flag, not a kill.** The job asks whether it should stop at
a boundary it knows is safe, and stops there. The retention run checks between
batches, and each batch is its own transaction, so stopping there leaves the
table in a state that an interrupted run would also leave — and stopping inside
one would leave a half-deleted table that nobody asked for.

**A cancelled job is neither a failure nor a success.** It is not retried, since
a retry would do the work nobody wanted done. It is not dead-lettered, since a
dead-letter entry says something is broken and nothing is. Its deduplication key
is released, since the work was not done and holding the key would skip the next
attempt.

**The retention log grows a `cancelled` column.** It already had `timedOut`, and
a cancelled run leaves the same shape behind it: some tables cleaned, some listed
in `pending`. `pending` alone cannot tell them apart, and a record that cannot
tell them apart is a record an operator has to guess at. The alternative was
leaving it out and letting the job's own record carry the reason — and that
record lives in redis with a TTL, so a question asked a week later about a run
from last Tuesday would have no answer in it, while the log table keeps a row
forever.

**What the progress counts.** The run's targets, not its rows. The number of
rows is not known until the rows are counted, and counting them would mean
scanning every table twice — once to count and once to delete. The targets are
known up front, and the target in flight is the part an operator actually
reads: "it is on notification_logs, the seventh of nine" says more than a
percentage.

**Who may stop a job.** The super administrator alone, like `MaintenanceRun` and
`UserDelete`. Stopping a job is irreversible and leaves the work half done, and
the person who starts a job is not always the person who should be able to stop
it. Watching stays with the administrator, because watching changes nothing.

**What it gives up**

- The progress is per job, not per queue. There is no "show me everything that
  is running" list, because a list of jobs is a different question and a
  different route, and Phase 26 is where the read surfaces are decided.
- A cancelled job's progress is kept for the same TTL as any other job's. The
  record of a job somebody stopped is not interesting for longer than the record
  of a job that finished.
- The `cancelled` column on `maintenance_logs` is a schema change for a flag
  that could have been a word in the log line. It is a column because a record
  an operator cannot interpret without guessing is not a record.

**Carried into Phase 26**

An audit read surface is a filter set over a table, and Phase 24's criteria
object is what a route's filters are made of. The permission question Phase 25
had to answer — who may read operational state, and who may change it — is the
same question Phase 26 asks about audit rows, and the answer there should be
recorded the same way.

---

## feat: a reusable query criteria object

`feat(query): a reusable query criteria object`

**What changed**

- `src/common/query/`: `query-spec.ts` (a route's whole query surface, and
  `defineQuerySpec`), `query-criteria.ts` (the request as data),
  `build-criteria.ts` (a DTO plus a spec becomes a criteria),
  `apply-criteria.ts` (a criteria becomes SQL), `read-page.ts` (the one call a
  list route makes), `filter-operator.ts` (the closed operator set)
- `USER_QUERY_SPEC`, `DEVICE_QUERY_SPEC`, `SESSION_QUERY_SPEC` and
  `RETENTION_QUERY_SPEC` — one object per list route
- `GET /users`, `GET /auth/sessions`, `GET /auth/devices` and
  `GET /admin/retention/runs` migrated onto it
- Deleted: `common/pagination/sort.ts` (`resolveSort`), `common/pagination/cursor-pagination.ts`
  (`paginateByCursor`), `USER_SORT_FIELDS`, `DEVICE_SORT_FIELDS`,
  `SESSION_SORT_FIELDS`
- `common/pagination/` keeps the cursor codec, the query DTO and the page result

**Why**

Phase 23 built the paging. Every list route then assembled its own query around
it — the sort allow-list in one place, the filters as a hand-written `if` per
field in another, and the paging call in a third. A filter added to one of those
and not the other was a filter that never fired, and nothing said so.

**A route's query surface is one object.** The spec says which fields may be
filtered and sorted and which column each one means. The DTO says what the
request may contain. The service says "give me a page of this". There is no query
builder in the service, no filter loop, and no `hasMore` arithmetic.

**The spec and the DTO are checked against each other, in both directions.** A
filter the DTO does not declare could never arrive — the global validation pipe
strips a parameter the DTO does not name — so it would be a filter that can never
fire. A DTO property no filter declares is a parameter the client can send and
the route ignores: a client that asks for the inactive accounts and gets the
unfiltered list has been told a lie, and nothing in the code says the filter was
forgotten. Both are compile errors now.

**The operator comes from the spec, never from the request.** A request says
_what_ to filter by, not _how_. The set of operators is closed — `eq`, `neq`,
`gt`, `gte`, `lt`, `lte`, `in`, `ilike` — and each one is a literal in
`apply-criteria.ts`. There is no general-purpose "expression" operator, because
the mechanism is safe precisely because the set of shapes it can produce is finite
and each one is written out by hand.

**Every value is bound.** The SQL text carries column names and comparison
operators, both from the spec, and never a value. A value reaches postgres as a
parameter, which is the only place a value can go without being able to change
the meaning of the statement.

**The columns are qualified with the alias.** An unqualified column is ambiguous
the moment the query joins a second table, which is exactly what a future route
on the same entity will do. Phase 23 emitted `"createdAt"`, which was correct
only because no route joined anything.

**`ilike` owns the wildcards and the escaping.** A caller who had to write
`%term%` would eventually write `%` on its own, and the search would become a
full scan of the table with a filter that matches everything. A term that is only
whitespace is dropped rather than applied: `ILIKE '%   %'` matches nearly every
address, which is a filter that looks like a filter and behaves like no filter
while costing a scan.

**The scope is not a filter.** `GET /auth/devices` answers "your own devices" and
`GET /auth/sessions` answers "your own live sessions". That is applied by the
service to the query builder, and no query parameter can widen it. A filter the
client controls and a scope the server decides are different things, and the code
says which is which.

**`hasMore`, still not a total.** One row past the limit answers it for free;
`COUNT(*)` answers it by reading every matching row, and goes stale between pages
anyway.

**What it gives up**

- Two things that were separate are now one. `resolveSort` and `paginateByCursor`
  are deleted rather than kept as a second way to do the same thing, so a future
  change to the boundary is a change in one place. The two Phase 23 spec files
  moved with the code they tested; the behavioural suite — including the
  concurrent-insert proof — is now `query/read-page.spec.ts`.
- The `QueryCriteria` is a plain object, not a class. It is data, and it is
  compared and asserted on in tests, and a class would buy nothing here.
- The spec is per _route_, not per entity. Two routes over one entity declare
  two specs, and they may differ — which is right, because a route's query
  surface is a property of the route.

**Carried into Phase 25**

A job that reports progress needs to say "the first N of M rows" and a
cancellation needs to be honoured at a chunk boundary. Both are easier against a
criteria that is data than against a query builder that has been half-built, and
Phase 26's audit read surface is a filter set like any other.

---

## feat: cursor pagination

`feat(pagination): cursor pagination`

**What changed**

- `src/common/pagination/`: `cursor.ts` (opaque, versioned base64url boundary),
  `sort.ts` (the sort allow-list and `resolveSort`), `cursor-pagination-query.dto.ts`
  (`limit`, `cursor`, `sort`, `order`), `paginated-result.dto.ts`
  (`PaginatedResultDto`, `PageMetaDto`), `cursor-pagination.ts` (`paginateByCursor`)
- `ApiSuccessResponse.meta`, and `ResponseTransformInterceptor` lifting a page's
  `meta` to the top of the envelope
- `GET /users` paged, filtered (`role`, `isActive`, `isEmailVerified`, `email`
  substring) and sortable over an allow-list of four columns
- `GET /auth/sessions` and `GET /auth/devices` paged; device names for a page
  resolved by id (`DeviceService.deviceNamesByIds`) instead of by listing them all
- `GET /admin/retention/runs` paged; `RetentionRunListDto` and the hand-rolled
  `limit`/`offset` clamping helpers deleted
- `PaginationQueryDto` and `DEFAULT_PAGE` deleted rather than wired in
- `RefreshTokenService.listLiveByUserId` deleted — the paged path replaced its only
  caller
- Migration `1792400000000-AddCursorPaginationIndexes`: `(createdAt, id)` on
  `users` and `maintenance_logs`, `(userId, isActive, createdAt, id)` on
  `user_devices`, `(userId, createdAt, id)` on `refresh_tokens`

**Why**

Four routes returned an unbounded result set, and `PaginationQueryDto` existed
unused — an unused DTO reads as a plan and is not one.

**Keyset, not offset.** `LIMIT n OFFSET m` makes the database count and discard
`m` rows per page, so page 900 reads nine hundred rows to return twenty. Worse,
that count happens inside the same statement as the read, and Postgres may
evaluate it under a different snapshot: a row inserted between two requests can
then appear on both pages or on neither. A cursor names the boundary it stopped at,
so an insert ahead of the reader cannot move it. That is the phase's acceptance
criterion, and it is a test in `cursor-pagination.spec.ts` rather than a claim in a
comment: rows are inserted between two page reads and every original row is
asserted to appear exactly once.

**The boundary is `(sortColumn, id)`, compared as a tuple.** `createdAt` is not
unique — a burst of signups shares a timestamp — and Postgres owes no ordering to
equal keys, so a boundary on the sort value alone either re-reads or skips the rows
that tie with it. The id is the tie-break.

**`hasMore`, not a total.** One row past the limit answers it for free;
`COUNT(*)` answers it by reading every matching row. It also goes stale between
pages, so "page 4 of 12" becomes "page 4 of 13" with a different set behind it.
Removing the total from the retention history took its `COUNT(*) OVER()` with it —
a window function over a table nothing prunes, on the screen an operator opens when
something has already gone wrong.

**Sorting is an allow-list map, and the map is the injection boundary.** Sorting by
a client-supplied name is SQL injection under a different spelling — identifiers
cannot be bound, so anything interpolated is a hole. `resolveSort` takes a
`const` object, so there is no path from the request to a column, and an undeclared
field is a 400 listing the valid names rather than a silent fallback: a client that
asks to sort by `password` would otherwise get a valid page in some other order and
believe it got what it asked for. The keys are checked with `hasOwnProperty`, so
`constructor` and `__proto__` resolve to nothing.

**Filters are declared properties, not a `where` bag.** A DTO accepting
`{ [column]: value }` would let a caller read any column the entity has,
`password` included, and would need a per-entity deny-list to stop it.

**`?isActive=false` works.** `@IsBoolean()` rejects the string `"false"`, which is
exactly what a client sends to ask for inactive users, and the workarounds are
worse: omitting the parameter returns _active_ users, answering the opposite
question.

**A malformed cursor is a 400.** Ignoring it hands back page one for a request for
page four — a correct-looking response to the wrong question, which a client renders
as "no results".

**The envelope is unchanged for a client that reads `data`.** `data` is still the
array the route always returned; `meta` sits beside it. A route that is not paged
has no `meta` at all rather than a null one, so it cannot be confused with an
empty page.

**Sortable columns must be `NOT NULL`.** A cursor carries its boundary as a string
and `null` would have to be encoded as something the decoder reads as malformed, so
nullable columns are absent from the allow-lists. That restriction is why
`lastUsedAt` is not sortable on `GET /auth/devices` and why `sessionStartedAt` is a
filter to be written rather than an `ORDER BY` to be added.

**Ascending indexes only.** Postgres scans an index backwards for the opposite
direction, so `?order=asc` costs nothing and a descending copy would be maintained
on every insert for no query it enables.

**What it gives up**

- No total, and no last page. A client that needs a count walks to the end. That is
  the honest cost of a consistent snapshot and cheaper than a count that lies.
- No jumping to an arbitrary page. There is no `?page=4`, and that is the point:
  a page number is the value that goes stale mid-walk.
- `GET /admin/retention/runs` no longer reports a total. Breaking, and noted in
  `src/modules/admin/` and `src/modules/maintenance/` docs.
- Cursors cannot be shared or bookmarked across different sort orders. The cursor
  encodes the boundary value, not the sort, so a cursor from `?sort=email` used
  against `?sort=createdAt` is a wrong answer rather than an error. Cheap to close
  by putting the sort into the payload and refusing a mismatch; not done here
  because no client needs it yet.
- The migration takes a brief write lock on `users` and `refresh_tokens` rather
  than using `CONCURRENTLY`, which TypeORM cannot run inside a transaction.

**Carried into Phase 24**

The reusable criteria object is now mostly assembled: `resolveSort` plus
`paginateByCursor` is sorting, filtering and paging in one place. What Phase 24
adds is the middle part — filters as data rather than as hand-written
`andWhere` calls — so that adding a list route needs no new pagination code.

---

## feat: give a session a maximum age

`feat(auth): give a session a maximum age`

**What changed**

- `refresh_tokens.sessionStartedAt`: a fixed point per session, carried forward by
  every rotation
- Migration `1792300000000-AddSessionStartedAt`, backfilled from `createdAt`, with
  an index on `(userId, sessionStartedAt)`
- `RefreshTokenRevokedReason.AbsoluteTimeout`
- `src/configs/session.config.ts` with `SESSION_ABSOLUTE_TTL_SECONDS`, default
  30 days, zero disables
- The check, in `rotate()`, after reuse detection and before a token is issued

**Why**

`JWT_REFRESH_EXPIRES_IN` is a sliding window. Every rotation mints a fresh token
with a fresh expiry, so a client that refreshes before it lapses is never refused
and one session can outlive any length of time — nothing in the schema counted
rotations, which is why `GET /auth/sessions` could list a session a year old and
mean it.

**Checked at rotation, not per request.** Only a rotation extends a session;
between refreshes the access token expires on its own within minutes. So the whole
control costs one comparison at `POST /auth/refresh-token` and nothing on the
request path. The alternatives were a Redis sliding window — a write on every
request, on a cache that fails open here, so a Redis outage silently removes the
timeout — or an access-token claim, which cannot express idle at all because a
stateless token does not know when it was last used.

**One column, because `createdAt` slides.** A rotation creates a new row, so every
live token in a chain carries the time of the most recent refresh rather than the
time the session began. The chain cannot be walked backwards to recover it either:
`replacedById` points forward, so the root is reachable only in the direction the
schema does not index. Carrying the value forward is also what makes this a
ceiling rather than a second sliding window — using the session cannot buy it
another allowance. There is a test for exactly that, and it fails if the
forward-carry is dropped.

**Backfilled from `createdAt` rather than left at the migration's `now()`**, which
would have handed every signed-in user a brand new lifetime clock and made every
live session look like it had just started.

**`AbsoluteTimeout` is deliberately not `Rotated`.** `Rotated` is the only reason
reuse detection treats as theft. A phone left on a train comes back holding a token
already revoked under this reason, and answering with the account-wide sweep would
revoke every session the user has, including the one they are signing in to. A
user locking themselves out by leaving a device unattended is a denial of service
an attacker gets for free.

**What it gives up**

The response is the existing `expired`, 401. A client cannot act differently on
"your session is too old" than on "your token expired", and inventing a status
would only give it one.

There is no idle timeout, so a session nobody touches is still ended only by its
own window. And an access token minted just before the deadline stays valid for up
to `JWT_EXPIRES_IN`; that is inherent to a stateless access token, and it is the
trade OAuth's security BCP makes for the same reason.

---

## fix(auth): say at boot that the breach check is off

`fix(auth): say at boot that the breach check is off`

**What changed**

`PasswordPolicyService` warns at boot when `PASSWORD_CHECK_BREACH_LIST` is false,
naming the variable and saying what the check actually sends.

**Why**

`PASSWORD_CHECK_BREACH_LIST` defaults to false because it is a network call in the
request path, and that is a good reason to leave the choice to whoever runs the
deployment. The problem was not the default, it was the silence: a password that
appears verbatim in a breach corpus is accepted, and nothing in the logs, the
response or the documentation says so at the moment an operator would look.

Warned rather than defaulted on. Flipping it would put an outbound HTTPS call in
the middle of every registration and reset for every deployment, including the
air-gapped ones, to fix a problem that is about the operator not knowing.

There is already a `log` line for a missing zxcvbn in the same constructor; this
is the same idea for the same reason.

---

## fix(core): redact the columns and messages that could carry a secret

`fix(core): redact the columns and messages that could carry a secret`

**What changed**

- `audit_logs.error`, `mail_logs.error` and `notification_logs.error` pass through
  `redactText` **before** they are clipped
- `notification_logs.body` gets the same treatment
- `postJson` no longer interpolates an unparseable url into its error message
- Three new text patterns for credentials that are a url path rather than a
  `key=value`: `hooks.slack.com/services/…`, `discord.com/api/webhooks/…`,
  `api.telegram.org/bot…`
- `refresh_tokens.jti` added to `REDACTED_KEYS`

**Why**

Four places where a credential could reach a database column, all of them the same
shape of mistake: a value that arrives verbatim from something else is clipped and
stored, and clipping looks like handling.

**The order was wrong.** The first 500 characters of an exception message is
precisely where a token in a query string sits, so the clip preserved the part
that mattered and discarded the rest.

**A webhook url is the credential.** `postJson` rejected an unparseable url with
the url interpolated into the message. Slack and Discord incoming webhooks carry
the bot token in the path, and that message is caught by the notification service
into an `error` field, which is a database column — so a misconfigured webhook
wrote a live credential into `notification_logs`.

**The redactor could not see it anyway.** None of the text patterns match a secret
that is a url path, so three more were added, pinned to the hosts the channels
actually post to. Redacting every url path would fire on ordinary prose, and a
redactor that cries wolf is one people switch off — there is a test for that
specific property.

`jti` is not an access credential, but it is half of `token:revoked:<jti>`, the key
that decides whether a session is dead, so anyone holding it can enumerate which
sessions exist and which were cut.

**What is deliberately left alone**

`actorEmail`, `ipAddress` and `userAgent`. They are personal data by definition,
and a redactor that removed them would make the audit trail useless for the
incident it exists for.

Ten new tests, all verified to fail against the code they replace — by reverting
each file and watching the suite go red rather than by reading the code.

---

## fix(auth): hash recovery codes with scrypt like passwords

`fix(auth): hash recovery codes with scrypt like passwords`

**What changed**

- `hashRecoveryCode` uses scrypt with a per-code salt
- The stored value names its derivation: `scrypt$…`, with `sha256$` still verified
  and never written
- `verifyRecoveryCode` is async, and both `TwoFactorService` call sites are awaited
- The find-then-filter in `consumeRecoveryCode` is now a single pass

**Why**

A recovery code is ten characters of a 32 symbol alphabet — about 50 bits — and it
was stored as SHA-256 with a salt. Against a leaked table of those, SHA-256 runs at
billions of hashes a second on a GPU, so fifty bits stops being much of a defence
when the guessing is free. Passwords in the same table already used scrypt: the
credential an attacker with the database wants most was the one hashed cheapest.

**The stored value naming its derivation is what makes the upgrade safe.** `sha256$`
rows from a previous deployment still verify — same salt, same digest, and the
prefix is what tells it apart — and they are never written, so they age out as
codes are spent with no migration to run.

**Verification is now async, which is the part that needed care in the caller.** A
Promise is truthy, so the old `!this.isRecoveryCode(record, code)` would have
accepted every wrong code ever typed.

**Cost of the fix, stated plainly:** a wrong code costs one derivation per
remaining code, roughly a second, and a correct one costs about two. That is the
right place for it — a recovery code is used a handful of times before the lockout,
and it is precisely the credential worth the expense.

---

## fix(auth): derive the two-factor key with scrypt, not a single hash

`fix(auth): derive the two-factor key with scrypt, not a single hash`

**What changed**

`deriveKey` uses `scryptSync` with a fixed, versioned salt instead of a single
SHA-256 of the passphrase.

**Why**

One operation between `TWO_FACTOR_ENCRYPTION_KEY` and the AES-256-GCM key that
protects every enrolled TOTP secret in the table.

The exposure is narrow but the failure is total. A passphrase in an environment
file is the thing an operator writes as `changeme`, copies between two deployments,
and forgets — and the whole defence of the stored ciphertext was that reading it
required guessing that string. With one SHA-256 it requires guessing it at hash
speed, which is not a defence at all. That matters most in exactly the case the
encryption exists for: somebody has the database.

The salt is fixed rather than random, and has to be — the derivation must be
deterministic or nothing decrypts on the next boot. It is versioned in the string
so a future change is recognisable as one.

**What it gives up**

**This invalidates every stored two-factor secret.** The derived key changes, so
existing ciphertext no longer decrypts and those users re-enrol.
`TWO_FACTOR_ENCRYPTION_KEY` itself does not have to change. It is a one-way door
for a deployment that already has users enrolled.

The cost is paid on enrol, disable and two-factor login — three paths — and never
on the password path.

New spec, because this file had none. The derivation is asserted structurally
rather than by timing: a test that measures how long derivation takes fails on a
fast machine and passes on a slow one, and a failing timing test is a test people
delete.

---

## fix(auth): route the password reset through the policy service

`fix(auth): route the password reset through the policy service`

**What changed**

`PasswordResetService.consume` asks `PasswordPolicyService.checkForUser()` once the
token has named the user, replacing a hand-rolled reuse check with its own message.

**Why**

`checkForUser()` was written to be the uniform entry point — `check()` plus the
reuse half — and had no callers anywhere in the repository. The reuse check it
wraps existed anyway, inside the reset transaction, with its own idea of what to
say. Two implementations of one rule is the state that lets them drift.

The service now reports every reason the policy gives rather than a bespoke
sentence, because a user who typed a password failing the length rule and reuse at
once should see both.

**The global half now runs twice on a reset.** `AuthService.resetPassword` still
calls `assertPasswordAcceptable` before opening the transaction, and `consume`
calls the full check inside it. Deliberate: the first rejects an obviously bad
password without taking a row lock and running scrypt to discover it; the second is
authoritative because it is the only place that can ask about reuse. The breach
lookup is cached by prefix for thirty days, so the repeat is a cache read in steady
state.

No new module edge: `PasswordPolicyService` is provided in `AuthModule` and
`PasswordResetService` lives in it.

**What it does not reach**

The admin create and update paths still bypass the policy entirely. Closing that
needs `UsersService` to see the policy, and the obvious route is a
`UsersModule` → `AuthModule` import, which is a genuine Nest-level cycle because
`AuthService` injects `UsersService` back.

---

## fix(auth): make the lockout settings mean something

`fix(auth): make the lockout settings mean something`

**What changed**

`LoginLockoutService` reads `LOGIN_MAX_FAILED_ATTEMPTS` and
`LOGIN_LOCKOUT_DURATION` from the `passwordPolicy` namespace instead of two local
constants. `AccountLockService` asks the lockout for its threshold rather than
reading the export.

**Why**

Both variables were declared in `PasswordPolicyConfig`, validated in
`env.validation.ts` and advertised in `.env.example` — and never read. An operator
who raised the threshold to ten for a deployment behind a corporate proxy got five,
with nothing in the logs or the response to say so. The configuration was real
enough to pass a review and useless enough to be a trap.

**`LOGIN_LOCKOUT_DURATION` is the ceiling on the ramp, not a fixed length.** Three
minutes only bites once the one-minute ramp has climbed past it, and that is the
reason it is a separate setting from the base — a fixed duration would either make
five typos cost fifteen minutes or make a sustained attack stop costing anything.

`LOGIN_MAX_FAILED_ATTEMPTS=0` is the documented off switch, so it is a real one:
`inspect` and `recordFailure` return early and never touch Redis, rather than
using a threshold no count can reach.

`AccountLockService` now asks rather than reading the constant, because that
constant is only the default now, and comparing against a hard-coded 5 would have
silently disabled the permanent lockout for exactly the operator who raised the
temporary one.

Four tests, all verified to fail with the config ignored.

---

## fix(users): hash a password sent through the update route

`fix(users): hash a password sent through the update route`

**What changed**

`UpdateUserDto` gains an optional `password`, and `UsersService.update` hashes it.
Setting it bumps `sessionsVersion`.

**Why**

`UpdateUserDto` had no `password` field at all, so `PATCH /users/:id` could not
change a password — and adding one without hashing would have put the cleartext bug
back one route over from where the previous commit removed it. The client sends what
the user typed, the same contract `register` and `CreateUserDto` have, and the
service owns the digest.

The password is destructured out of the DTO rather than merged as received:
`merge` assigns every key it is handed, so passing the body through with `password`
still attached would have written the plaintext no matter what the code above it
decided — the one way this fix could silently not apply.

**The version bump is the half that is easy to leave out.** An administrator
resetting a password for somebody who cannot reach their inbox is closing a door
the old key still opens, and without the bump every token minted under it keeps
working for the rest of its lifetime. It is bumped only when the password is
actually in the body: doing it unconditionally would sign the user out of every
device each time an operator fixed a typo in a name.

Four tests, three of which fail against the merge-as-received version.

**What it deliberately does not do: tell the user.** `password-changed` and
`new-device-login` both exist as mail templates and neither has ever been sent by
anything. An admin reset is now reachable, so the account owner is not told their
credentials changed.

---

## fix(audit): bind the interceptor so a right-to-erasure writes a row

`fix(audit): bind the interceptor so a right-to-erasure writes a row`

**What changed**

`@UseInterceptors(AuditInterceptor)` on `AccountLockController`, and `AuditModule`
added to `AuthModule`'s imports.

**Why**

`POST /auth/account/erasure` carried `@Audited({ action: 'users.erasure.requested' })`
from the day it was written and never wrote an audit row. The controller bound no
interceptor, and `AuthModule` did not import `AuditModule`, so the metadata was read
by nothing at all.

An erasure request is the most sensitive event in a right-to-be-forgotten workflow —
the one where somebody asks for their data to disappear — and it left no trace of
having happened.

**The reason it survived is the reason this is worth writing down.** Every
assertion in `audit-policy.spec.ts` reads _handler metadata_, and handler metadata
is happy to describe an intention nobody acts on. The route had a correct action
name in the dotted form, unique among its peers, on a route that still existed. All
six checks passed over a decorator that was never going to run.

So the file grew a second block that reads the `__interceptors__` binding on the
controller class — the thing that was actually missing.

`AuditModule` imports nothing but TypeORM, so adding it to `AuthModule` is a
one-directional edge and cannot close a cycle.

**One trap**, because it cost a rewrite: `expect(undefined).toContain(x)` **passes**
under vitest rather than throwing. The obvious spelling of that assertion is
vacuous on precisely the case that matters, where the metadata is absent rather
than wrong.

---

## fix(users): hash the password on every path that creates an account

`fix(users): hash the password on every path that creates an account`

**What changed**

`UsersService.create` hashes the submitted password and returns the entity rather
than the response DTO. `AuthService.register` passes the plaintext and reads the
digest back off the return value. `UsersController` maps to the DTO.

**Why**

`POST /users` persisted the submitted password in clear text.

`UsersService.create` wrote the string it was handed straight to the repository.
That survived review because its one careful caller pre-hashed: `AuthService.register`
had to hold the digest anyway, to record it in the password history. `POST /users`
has no such reason, so an administrator creating an account — a route behind
`@Roles(Admin, SuperAdmin)` and `@Permissions(UserWrite)` — put a live credential
into the one column the rest of the system assumes holds a scrypt digest.

**It failed quietly, which is why 1962 assertions did not catch it.**
`verifyPassword` splits the stored value on `:` and returns false when there is no
second part, so that account could never sign in: the row was created, the response
was 200, and no test ever had that user authenticate. A suite asserting "a user was
created" passes on a stored plaintext.

Hashing moves into `create`, which makes it the single writer of the column, and
`register` reads the digest back rather than computing its own — one scrypt call per
signup, and the hash recorded in the history is provably the one that was stored.

Three tests, each verified to fail against the old code by reverting it.

---

## docs: add an installation guide and per-module introductions

`docs: add an installation guide and per-module introductions`

**What changed**

- `docs/installation.md`: the two things that bite people who skip to
  `npm run start:dev`
- Eight `INTRODUCTION.md` files, one per module, each linking from its `README.md`
- `src/modules/README.md` gained an index
- OpenCode credited in the README and in `CONTRIBUTING.md`

**Why**

The README said "copy .env.example and start it" and left the two things that bite
people to the first error message: `npm ci` installs the git hooks through the
prepare script, and the placeholder secrets in `.env.example` are rejected at boot
in production, which reads as a failure until you know it is the validator doing
its job.

Every module gained an `INTRODUCTION.md` beside its README. The README answers _why_
a decision was made; the introduction answers _what is there now_, and the two had
drifted apart across 22 phases.

**The standards mappings are technical, not compliance claims, and say so at the top
of every table.** A control being present is one input to an assessment; HIPAA
compliance additionally needs administrative and physical safeguards, policies,
training, a risk analysis and a business associate agreement, none of which are
software. Where a control is partial or absent the table says so — two of the eight
technical safeguards are absent outright (automatic logoff, emergency access) and
that is worth more to a reader than a green tick.

The gap tables are the reason to publish these. Writing only strengths would be
marketing, and an audit that discovers a gap the README did not mention reads worse
than one that found it documented.

---

## style: drop a defensive array copy that oxlint flags

`style: drop a defensive array copy that oxlint flags`

`unicorn(no-useless-spread)` was reporting the copy in the block-expiry test, and it
was reporting it correctly: the array buys nothing. The loop iterates
`store.keys()` and calls `store.set(key, ...)` on a key the Map already holds.
Setting an existing key does not change a Map's key set, so the iterator is not
disturbed and the copy protects against nothing. It was a habit from iterating an
array that could have been appended to underneath the loop.

---

## ci: pin the runner image and move to the node 24 action majors

`ci: pin the runner image and move to the node 24 action majors`

**What changed**

- `actions/checkout@v4` → `@v7`, `actions/setup-node@v4` → `@v7`
- `docker/setup-buildx-action@v3` → `@v4`, `docker/build-push-action@v6` → `@v7`
- `ubuntu-latest` → `ubuntu-24.04` on all three jobs
- `NODE_VERSION` hoisted to a top-level `env`

**Why**

Every run warned twice, which is how a warning stops being read.

The v4 actions target Node 20, which GitHub has deprecated: they still work, forced
onto a newer runtime, and print the same notice on every job. Each version was
confirmed to exist against the GitHub releases API rather than assumed from the
shape of the deprecation notice.

`ubuntu-latest` is pinned for the same reason. GitHub announces the label migrates
to Ubuntu 26 on 19 October 2026, which would move every job without a commit, and a
CI failure should be a change in this repository rather than a change in the runner.
The pin wants bumping deliberately, as its own commit, when the image it names is
retired — which is the moment a pin becomes the problem.

---

---

## test: run the end to end suite against real containers

Phase 21. Intended commit: `test: run the end to end suite against real containers`

**Tasks**

- [x] `test/e2e/global-setup.ts` starts one Postgres and one Redis for the whole run
- [x] `test/e2e/harness.ts` reads the urls into `process.env`, boots `AppModule`
      through a dynamic import, and truncates every table between specs
- [x] `*.e2e-spec.ts` renamed so the unit vitest config stops matching it
- [x] Four e2e suites: optional dependencies, cache invalidation, retention dry
      run, and the auth flow
- [x] Every mutating request carries a distinct `Idempotency-Key`
- [x] `fileParallelism: false`, because two suites booting their own containers
      race for ports

**The bugs this found**

Every one of these passed every unit test and failed only once there was a real
database and a real Redis behind it. That is the argument for the suite.

- **The application did not boot at all, and 120 unit test files could not see
  it.** Six faults sat behind the first error each time:
  `NotificationEventsModule` re-exporting a provider belonging to an imported
  module; `ThrottlerModule.forRootAsync` injecting a token only the root could
  see; `SentryService` taking the DSN as a constructor parameter, which Nest
  read as an injection token, so every deployment with `SENTRY_DSN` set failed;
  `RetentionService` importing `DataSource` as a type, so its erased parameter
  reached the injector as `Object`; `RetentionScheduler` asking for a config
  namespace its module never registered; and three modules injecting a provider
  whose module only the root imported. `src/app.module.spec.ts` now builds the
  entire graph with a stubbed data source — no database, no Redis, no Docker —
  and was verified by reverting one fix and watching it fail with the same
  message the boot produced.
- **`RedisClientService` had no `@Injectable()`, so Nest constructed it with no
  arguments at all.** A class without a decorator emits no `design:paramtypes`,
  and the injector then supplies nothing. It was masked earlier because the
  broken client failed _fast_, which let the rate limiter fail open; with a real
  redis in CI the idempotency guard reached the command and every mutating
  request returned a 500. Every test in its own spec constructs the service by
  hand, so nothing noticed.
- **The module graph had a cycle, and it only failed outside `node dist/main`.**
  `QueueModule` imported `MaintenanceModule` through the `maintenance/index.js`
  barrel, and that barrel re-exports `MaintenanceSchedulerModule`, which imports
  `QueueModule` back. `node` resolved it by luck; vitest did not, and the job
  died with `The module at index [2] of the QueueModule "imports" array is
undefined` — a message that reads as a missing provider and is not one.
  `module-graph.spec.ts` now fails on any value-import cycle, and type-only
  cycles stay legal because the compiler erases them.
- **The e2e harness was booting a different application from the one that
  ships.** `setGlobalPrefix`, URI versioning, the validation pipe, the filters
  and the response wrapper all lived inline in `main.ts`, so a test-created
  application had no prefix and no wrapper: `/health` was a 404, every success
  body was bare rather than `{ success, data, timestamp }`, and the "unknown
  path returns 404" test passed for the wrong reason. `main.ts` now delegates to
  `src/bootstrap.ts`, which both it and the harness call.
- **`POST /auth/login` answered 201.** Nest defaults POST to 201, and a sign-in
  creates nothing. `@ApiOkResponse` already documented 200 on all three token
  routes, so the wire and the documentation disagreed.
- **`node-redis` retries a failed connection forever, so `connect()` never
  rejects.** The client promises that a dead redis is a miss rather than a hang,
  and with the default reconnect strategy the first command awaited never
  settles. Measured against a dead port: no rejection at all, with `connectTimeout`
  at 250ms. The factory now bounds its retries, which is what makes `connect()`
  reject and `run()` report a miss.
- **The harness's fake agent was a function; supertest's is not.** Two bugs in
  one function. `Object.assign(wrapped, agent)` copied supertest's verb methods —
  closures over the agent — so `http(app).post(...)` went straight to the
  original and the `Idempotency-Key` was never sent: every mutating route
  answered 400, in files that had nothing to do with idempotency. The fix called
  the agent itself, and `request(server)` is an **object**, so every request in
  the suite became `TypeError: agent is not a function`. `createHttp()` now
  builds through `agent[verb](url)`. **A fake models what the dependency is, not
  what the code wishes it were.**
- **`whitelist: true` strips any property no class-validator decorator names,
  and two request DTOs had none.** `PUT /admin/roles/:role/permissions`
  answered 400 for every call, and `PATCH /notifications/preferences` had
  nothing to write. `@ApiProperty` is documentation and nothing else, so Swagger
  advertised fields the application never received.
- **The idempotency key was a counter, and vitest resets it per file.** Every
  file's second `POST /auth/register` sent the key the previous file's second
  register sent, so the guard replayed the earlier file's stored response: a
  registration reported as created when the row had never been written, and the
  sign-in after it answered 401 for an address that did not exist.
- **`resetRedis` only cleared the cache's database.** The throttle counters,
  deduplication markers, idempotency claims and dead-letter list live in the
  queue's redis. A rate limit therefore carried across spec files, and a later
  file hit a 429 for a request nothing in it had made — which reads as a broken
  route rather than as leftover state.
- **A stale `test/.e2e-env.json` switched the suite on while the setup was
  skipping it.** `E2E_NO_CONTAINERS=1 npm run test:e2e` reported `5 failed (5)`
  files alongside `30 skipped` tests. The setup now removes the file whenever it
  skips, not only when it writes one.
- **The initial migration needs `uuid-ossp`, which a fresh container does not
  enable.** The e2e setup creates it before migrating, rather than editing an
  applied migration.
- **A verification token row needs the address it was minted for.** The test's
  own `INSERT` omitted a NOT NULL column, so the account was never verified and
  every later refresh was refused — a cascade that looked like an application
  fault and was a fault in the fixture.
- **`RedisClientService.eval` did not namespace its keys.** The throttler's
  counters sat in the root namespace while every other queue key sat under
  `REDIS_KEY_PREFIX` — two deployments on one redis sharing a rate limit.
- **Locking a user invalidates their access token, and unlocking does not bring
  it back.** `lockAccount` bumps `sessionsVersion`, which is compared on every
  request. The account is reachable again, that session is not — which is the
  point of a lock, and which the cache suite had asserted the opposite of.
- **An `@Permissions()` route is also `@Roles(Admin, SuperAdmin)`, always.** The
  first version of the cache suite drove a grant change through http with a
  plain user and would have passed with the permission cache deleted, because
  the role guard refuses first and never reaches the permission guard.
- **Mail rows are polled for, never read straight after a request.** The queue
  resolves its enqueue before the job runs, so an assertion on `mail_logs` on
  the next line is a race that passes on a fast machine and fails in CI.

**Decisions worth carrying forward**

- **The suite skips without Docker and CI does not skip.** `E2E_NO_CONTAINERS=1`
  exists so the e2e job can work on a laptop. The CI job deliberately omits it,
  because a job that could not start its containers would otherwise report
  success on nothing. The first version surfaced testcontainers' own
  `Could not find a working container runtime strategy`, which names what was
  looked for and nothing about what to do next.
- **Nothing was moved into `optionalDependencies`.** npm installs an
  `optionalDependencies` entry whenever it resolves, so a test relying on it
  would pass on a machine with a warm lockfile cache and prove nothing on the
  machine that needed it. The assertion is the fallback path.
- **No e2e assertion waits out a TTL.** A cache test that sleeps for the expiry
  passes just as well when the invalidation is deleted. The suite reads redis
  directly and asserts the key is gone.
- **The soft delete in the cache suite goes through the service, not a raw
  `UPDATE`.** A write made directly in the database is invisible to invalidation
  by design, so asserting it there would be asserting a limitation as a
  guarantee.
- **`testcontainers` gave up its convenience classes.** `PostgreSqlContainer` and
  `RedisContainer` are no longer exported from the package entry point, and
  reconstructing them is thirty lines of wait strategies to maintain. The Postgres
  wait is on the log line rather than `pg_isready`, which answers before the
  server accepts connections from anything but its own socket.
- **A seeded admin is not a super admin, on purpose.** The seeder creates
  `Role.Admin`, which holds neither `RoleWrite` nor `MaintenanceRun`, so the
  harness promotes its fixture rather than re-seeding under a different role.

**Known limits**

- The e2e suite needs a Docker daemon, and runs one file at a time.
- `test/app.e2e-spec.ts` asserts the versioned prefix, which is what a client
  actually calls.
- The optional-dependency suite sets `MAIL_TRANSPORT=ses` and expects the memory
  fallback, so it does not prove a _present_ SES package works.

---

## test: add mutation testing, and a smoke test, for the expensive paths

Phase 21. Intended commits: `test: add a k6 smoke test`, `test: add mutation
testing for auth and retention`

**Tasks**

- [x] `test/smoke/k6-smoke.js` covering register, login and refresh
- [x] `stryker.conf.json` scoped to the auth and retention files
- [x] Both run on demand rather than on the pull request workflow

**Decisions worth carrying forward**

- **Mutation testing is scoped and off the pull request workflow.** Auth and the
  two retention files, because a flipped comparison there deletes or locks out
  something real and produces no exception. A full run takes minutes, which is
  the wrong price for every commit.
- **The smoke test registers a real user per virtual user.** It is a smoke test,
  not a capacity plan, so the defaults stay small and `docs/production.md` says
  why.

**Known limits**

- The k6 script needs `k6` installed and a booted instance; nothing runs it for
  you.
- Mutation testing runs on demand, so a surviving mutant is found by whoever
  runs it rather than by the pull request.

---

## docs: document the testing layers and the new variables

Phase 21. Intended commit: `docs: document the testing layers and the new variables`

**Tasks**

- [x] `src/modules/mail/README.md`, `queue`, `notification` and `maintenance`
- [x] `docs/production.md` and the root `README.md` updated with the new
      environment variables and the module list
- [x] Four layers documented by what each one can and cannot answer

---

## feat: add observability and operations for the new subsystems

Phase 20. Intended commit: `feat: add observability and operations for the new
subsystems`

Delivered as ten commits, each independently revertable.

**Tasks**

- [x] Extend `/health` with mail transport, queue connectivity and backlog depth,
      all reporting degraded rather than down
- [x] Expose the last successful maintenance run in the health payload
- [x] Prometheus metrics: `mail_sent_total`, `mail_failures_total`,
      `notification_sent_total`, `job_lag_seconds`, `retention_rows_deleted_total`
- [x] OpenTelemetry traces spanning HTTP, database and job execution
- [x] Propagate `X-Request-Id` into every log line, mail record and notification
      record
- [x] Sentry error reporting with release tagging
- [x] Alert rules: failure rate above a threshold, a non-empty dead-letter list, a
      maintenance job that has not run in 26 hours
- [x] Redact token, secret and OTP fields in the logger
- [x] `docs/runbook.md` for provider outage, Redis loss, queue backlog, and
      tracing a missing email through `mail_logs`
- [x] A Grafana dashboard for auth failure rate, job lag and mail delivery

**Decisions worth carrying forward, because each is a refusal of something**

- **Nothing new in `/health` is ever `down`.** `down` makes Terminus return 503
  and an orchestrator pulls every instance out of rotation, so a mail provider
  outage, a full queue or a dead redis would each turn a system that is still
  answering requests into an outage of the API itself. Only the database may go
  red.
- **The health check sends no mail and reads no backlog it cannot read.** A probe
  mail lands in a real inbox, and a zero waiting-jobs reading taken while redis
  is down looks healthier than an application with no jobs at all.
- **`@opentelemetry/api` and nothing else.** No SDK, no exporter, no collector —
  those would choose the deployment's tracing stack for whoever clones this.
  Install one and the spans appear; leave it out and every method is a no-op at
  the same speed.
- **Sentry's `beforeSend` strips headers, cookies, body and query string.** Those
  are where a password, a reset token and a two-factor code are. An error
  reporting service holding a sign-up body is a credential store with a far
  larger blast radius than the database.
- **Alert thresholds live in TypeScript and the YAML is checked against them.** A
  drifted alert stays green while the thing it watches is on fire — which is how a
  monitoring system gets turned off.
- **`mail_logs` was created rather than the correlation work narrowed to fit.** A
  request id stamped onto a table nobody queries is a column, and one on the table
  somebody queries when a user says they got nothing is the feature.
- **`auth_login_attempts_total` exists because a failure rate needs a
  denominator.** It is also the only sign-in signal that survives a redis outage,
  because the rate limiter and the lockout both fail open.

**What is deliberately not here**

- An admin route to read the audit trail. The table is written by Phase 19 and
  nothing reads it back; that is a decision about who may see it, not a gap.
- A generic signed webhook channel, dropped rather than half-built in the wrong
  phase.
- Distributed-trace retention. Storing spans is the collector's business, and a
  template that kept its own would be a second place to answer "where is that
  trace".

---

## feat: add account security, audit log and idempotency

Phase 19. Intended commit: `feat: add account security, audit log and idempotency`

Delivered as eleven commits rather than one, each independently revertable. The
plan named a single commit; the phase was large enough that one commit would have
made bisecting a regression a matter of reading the whole diff.

**Tasks**

- [x] A password policy in zod, with an optional `zxcvbn` strength score
- [x] New passwords checked against a breach list through the k-anonymity API
- [x] The last N password hashes kept and reuse rejected
- [x] An email verification gate, blocking sensitive actions until confirmed
- [x] A permanent account lockout with an unlock flow and a notification
- [x] An audit log entity: actor, action, before/after diff, ip, user agent,
      request id
- [x] Every privileged action recorded, through an interceptor
- [x] An `Idempotency-Key` header guard on mutating endpoints
- [x] `@VersionColumn()` on the mutable entities for optimistic concurrency
- [x] `user.requestDeletion()`: soft delete, hard delete at the end of the
      retention window
- [x] A data export endpoint, CSV and JSON, streamed

**Decisions worth carrying forward, because each one is a refusal of something**

- **A permanent lockout only ever applies to a confirmed address, and that is a
  code invariant rather than a setting.** An unverified account could never
  receive the unlock link, so locking one would be permanent with no owner able
  to clear it. A flag for this is one careless default away from locking every
  account in a deployment.
- **A locked account answers with the same 401 as an unregistered one.** A
  dedicated message is a free oracle for anybody willing to burn twenty attempts,
  and the owner has the mail.
- **The audit writer never throws.** An audit write that failed the action it was
  recording would mean an outage in the log becomes an outage in the product. The
  gap is logged at `error`; the trade is real and is that this trail can have
  holes.
- **`before` is null on every interceptor-written audit entry.** The interceptor
  sees the request and the response, never the row as it was, and a reconstructed
  before-state in a table presented as evidence looks like a record while being an
  inference.
- **No TypeORM subscriber**, for the same two reasons the cache phase reached for
  the hook: no dependency injection, and a query-builder write arrives without an
  id.
- **Idempotency uses redis directly, not the cache.** The cache fails open by
  reporting an unreachable store as a miss, and a miss on an idempotency check
  means "this request is new" — the exact duplicate it prevents.
- **An export never selects a credential.** The exclusion is structural rather
  than a filter at the output stage, because a column that is not selected cannot
  be rendered.

**What is deliberately not here**

- An admin route to read somebody else's audit trail. The table exists and is
  written; the query surface is a separate decision about who may see it.
- A generic webhook channel with HMAC signing, dropped rather than half-built.

---

## feat: add database-managed email templates

Phase 22. Intended commit: `feat: add database-managed email templates`

**Tasks**

- [x] `handlebars` as a dependency, with the cost of that stated in the README
- [x] `email_templates`: name, locale, subject, text, html, version, `updatedBy`
- [x] The nine templates shipped as `.hbs` files, seeded into the table
- [x] The database row is the override and the `.hbs` file the fallback
- [x] Rendered through `CacheService.wrap` under `CACHE_NAMESPACE.Mail`
- [x] Cache invalidated on every write, after the commit
- [x] `GET/PUT/DELETE /admin/mail-templates/:name` behind `mail-template:*`, audited
- [x] The triple-brace form refused in anything read from the database
- [x] The per-template data contract exposed as the allowed-field list
- [x] A preview rendered against sample data, storing nothing
- [x] `mail_template_versions`, purged on the retention window

**What it gives up**

The templates are no longer type-checked and `handlebars` is the first dependency
the mail path has for rendering rather than delivery. Both are real costs and
`src/modules/mail/README.md` says so next to the code that pays them.

**What it found**

- **`Handlebars.escapeExpression` corrupts a url.** It encodes `=` as `&#x3D;`, so a
  `?token=a&b=1` in an `href` reaches the mail client as `?token&#x3D;a&amp;b&#x3D;1`.
  Every verification and reset link would have been dead, found by asserting the
  rendered `href` and reading the entity back.
- **`knownHelpersOnly` throws at render, not at compile**, and `save` does not
  render — so a stored template naming an unknown helper would have been written and
  then broken every send.
- **`nest build` did not copy the `.hbs` files.** A top-level `assets` key in
  `nest-cli.json` is read by nothing; `compilerOptions.assets` is the one that works.
  The build succeeded and the first send failed.
- **The DTO guard reported a correct field as undecorated**, because the `}` closing a
  decorator's argument list was treated as closing a class. Still catches the real
  bug, verified by stripping the validator and watching it fail.

## feat: add multi-channel notifications

Phase 18. Intended commit: `feat: add multi-channel notifications`

**Tasks**

- [x] `NotificationChannel { name, isEnabled(), send() }`, and every channel behind it
- [x] Telegram, Slack and Discord over raw HTTPS, no package for any of them
- [x] Console as the development default, and email delegating to `MailService`
- [x] Per-channel enable flag, per-channel retry budget, and a dead-letter list
- [x] `notify()` asynchronous and failure-isolated
- [x] `notification_preferences`, opt-out per event and channel, with routes
- [x] `notification_logs`, one row per channel, purged by the retention job
- [x] MarkdownV2 escaping centralised, and Slack's `mrkdwn` escaping added beside it
- [x] Telegram forum topics, per chat and per event
- [x] Seven events: registered, deleted, failed logins, new device, 2FA on and off,
      retention anomaly

**Notes**

- **The module is split in two, and the split is forced by the graph.** The queue's
  router injects `NotificationProcessor`, which injects the delivery service, so that
  service cannot be in a module that enqueues. `NotificationModule` sits below the
  queue and `NotificationEventsModule` above it — the same shape Phase 16 used for
  retention. `notification.graph.spec.ts` asserts it, because a cycle does not fail a
  test, it fails at boot naming a provider rather than the import that caused it.
- **Retries are per channel, inside the service, not in the queue.** A queue retry
  would re-attempt every channel for the sake of the one that failed, and a Slack
  alert would arrive five times because Telegram was down.
- **A partial delivery is a job success.** The processor asks whether anybody
  received the notification, which is the opposite of `MailProcessor`'s question and
  for a concrete reason: mail is one recipient, a notification is several.
- **Every attempt is logged, refusals included**, with the rendered body. The row that
  says Telegram answered 401 is the row an operator needs at 3am, and a log of only
  successes cannot answer "did it arrive".
- **A failed preference lookup delivers anyway.** Failing closed would let a
  preferences outage silence every operator alert in the deployment.
- **Preferences have no foreign key to `users`,** against the precedent of
  `role_permissions`. A user row is soft deleted first and hard deleted by the
  retention job thirty days later, so a cascade would erase the preference at the
  moment an administrator restored the account.
- **Two emit sites were narrowed deliberately.** `auth.login.failed` fires for
  addresses that do not exist, because the lockout counts those and an operator
  watching for attack traffic needs to see them; `auth.device.login` fires only when
  the device row was created, because alerting on every sign-in trains an operator to
  ignore the channel.

### The parts of the plan that did not survive the code

- **Slack needed its own escaper.** `mrkdwn` is not Markdown: it escapes with HTML
  entities, not backslashes, so Telegram's `escapeMarkdownV2` would have rendered as
  a wall of backslashes and still left `<url|label>` clickable. A notification body
  carries a user-supplied email address, so without this an address containing `<`
  became a link in a shared ops channel. Two helpers, one per syntax.
- **`isNotificationEventKey` uses `Object.hasOwn`, not `in`.** The event name arrives
  off a queue, so `"constructor"` passed an `in` check and was then looked up in the
  registry as a function. Found by writing the test.
- **Discord could not reuse Slack's payload.** The Phase 12 comment said one
  implementation could serve both, and for the url and the transport that is true.
  The body is not: Discord ignores `text` and posts an empty message, because its
  field is `content` and it calls a section an `embed`. Reusing it would have
  delivered nothing while answering 200.
- **The dedupe key needed the subject id before the notification id.** The first
  version fell back to a fresh uuid for the recipient half, which made the key
  unstable for any event carrying only a `subjectId` — silently disabling
  deduplication for exactly the events that were using it.
- **A preference cache eviction lands after the whole batch, not between writes.**
  An eviction between two writes would let a concurrent read refill from a
  half-applied state and cache that answer for the rest of the TTL.
- **The `notification` mail template renders the app name in the footer, not the
  subject.** An operator triages a mailbox by subject line, and "Security alert"
  six times a day tells them nothing about which one to open. Every other template
  still names the app in its subject, so the shared spec became a per-template
  assertion.

## docs: document the authentication cache

Phase 17b. Intended commit: `docs: document the authentication cache`

**Tasks**

- [x] Replace the note saying authentication state is not cached, which Phase 17b
      made false
- [x] State the three keys, their TTLs, and the two rules that keep a stale entry
      from becoming an authorisation bug

**Notes**

- `src/core/cache/README.md` still carried the line from Phase 10 that
  `JwtStrategy` reads `isActive`, `role` and `isManager` on every request on
  purpose. It stopped being true the moment the claims moved into the cache, and a
  reader following it would conclude that a deactivation waits out a TTL.

---

## refactor: build the redis store through the keyv factory

Phase 17b. Intended commit: `refactor: build the redis store through the keyv factory`

**Tasks**

- [x] Stop building the redis client by hand
- [x] Close the store through Keyv's own `disconnect`

**Notes**

- The comment inherited from Phase 12 claimed `createKeyv` "only accepts a URL and
  hardcodes the socket options", so the store could not be configured. That is
  false for the installed version, whose first argument is `RedisClientOptions`.
  Verified by running both forms and reading one from the other.
- The hand-built client had a real bug: it was never closed, so `npm run seed`
  printed its last line and sat there with the event loop held open.

## feat: expose role permissions over the admin api

Phase 17b. Intended commit: `feat: expose role permissions over the admin api`

**Tasks**

- [x] `GET` and `PUT /admin/roles/:role/permissions`, behind `role:read` and
      `role:write`
- [x] Answer with what the role holds afterwards, not with what was requested

**Notes**

- The route exists so that changing a grant goes through the application, and
  therefore through the invalidation that follows a write. Before it, the only way
  to change a role's grants was SQL, which bypasses the cache and leaves the
  change waiting out the TTL.
- `role:write` is held by the super administrator alone. Handing it to `admin`
  would let one administrator grant themselves another administrator's.
- An unknown role is refused by a pipe rather than written: a role nobody holds is
  a role that can reach no guarded route and looks merely empty.
- This cannot catch an operator who still uses SQL. That window is documented in
  `SECURITY.md` and `docs/production.md` rather than closed, because nothing inside
  the application can see a write it did not make.

## fix: clear cached role grants from the permission seeder

Phase 17b. Intended commit: `fix: clear cached role grants from the permission seeder`

**Tasks**

- [x] Drop the cached grant set of every role the catalogue names
- [x] Derive the key list from `ROLE_PERMISSIONS` rather than listing roles
- [x] Fail soft, because a seed that cannot reach the cache has still seeded

**Notes**

- Without it a deploy that adds a permission keeps serving the old grant set until
  the entry expires, so the permission that was just deployed does not work. The
  direction is the safe one: the guard refuses rather than admits.
- Best effort on purpose. Failing the seed over a cache outage would turn an
  eviction problem into a failed deploy, and the operator is told instead.
- A no-op for `CACHE_BACKEND=memory`, and necessarily so: an in-process cache holds
  entries no other process can reach.

## feat: revoke a session's access token, and the one a rotation supersedes

Phase 17b. Intended commit: `feat: revoke a session's access token, and the one a rotation supersedes`

**Tasks**

- [x] Carry the session id in the access token, and refuse a revoked one
- [x] Record the session a rotation superseded, after the transaction commits
- [x] Return the revoked row's `jti` from the update rather than reading it back

**Notes**

- `DELETE /auth/sessions/:id` revoked the refresh token, so the session came back
  on the next refresh and the access token in the caller's hand kept working for
  the rest of its fifteen minutes. Nothing about the response changed; it was
  simply not taking effect until the token expired on its own.
- The session, not the access token, is the unit. Every access token from one
  refresh chain shares the id, so a revocation is one write; giving each token its
  own id would mean a revocation had to name every token that chain ever produced,
  and that set is not knowable from the database.
- Recorded **after** the commit, not inside it. Recorded before, a rollback leaves
  a client holding a live refresh token and no live access token at all. The first
  version had it inside, and the test that asserts the order is what noticed.
- The revocation key is written directly and never invalidated, because a revoked
  session has no column to re-read it from. It carries an exact lifetime, with the
  jitter every other entry gets switched off: an entry that expires early lets the
  tokens it revoked start working again.
- Rotation ending the old access token means a client that loses the response to a
  refresh is left with nothing, and its retry presents a rotated token, which is
  the reuse signal that drops every session on the account. A lost response and a
  leaked token are indistinguishable server-side, and the design already treated
  them as the same thing.

## feat: revoke an access token when its device signs out

Phase 17b. Intended commit: `feat: revoke an access token when its device signs out`

**Tasks**

- [x] A `sessionsVersion` on `user_devices`, incremented on sign-out
- [x] Carry the device and its version in the access token, and compare them
- [x] Revoke a device's tokens from `DELETE /auth/devices/:id` as well

**Notes**

- `users.sessionsVersion` is per account by construction: bumping it takes out
  every device at once. It cannot answer "is this session still allowed in",
  because a logout names one machine and the token named none, so the counter moved
  to where the scope already was.
- Setting `isActive` alone would have done nothing. The strategy never reads that
  column, so a revoked device with a row still in the table looks exactly like a
  live one.
- A device **absent** from the map is refused rather than skipped. Retention removes
  devices with no live refresh token, and treating absence as "nothing to check"
  would let a token minted before the deletion keep working for the rest of its
  lifetime.
- A token naming no device is not checked at all. That is every token minted before
  this claim existed, so reading it as revoked would sign out every signed-in user
  on deploy.

## perf: report cache loss as degraded

Phase 17b. Intended commit: `perf: report cache loss as degraded`

**Tasks**

- [x] Report an unreachable or mismatched cache as `degraded`, never `down`
- [x] Pin the terminus behaviour this relies on

**Notes**

- Everything downstream of redis fails open: rate limiting lets requests through,
  the lockout stops counting, the auth cache falls back to a query. The service
  keeps serving traffic throughout, more slowly.
- Terminus treats `down` as a failure and throws 503, so an orchestrator would pull
  every instance out of rotation over a redis problem and turn a cache outage into
  an outage of a system that was still answering requests. `degraded` lands in
  `info` and the request returns 200.
- The check still writes a value and reads it back. cache-manager turns a failing
  store into a miss, so a plain read cannot tell an unreachable cache from an empty
  one.

## perf: guard the sessions version against an uninvalidate write

Phase 17b. Intended commit: `perf: guard the sessions version against an uninvalidate write`

**Tasks**

- [x] Assert a revocation-critical column is only written where the cache is dropped
- [x] Assert the amount is an increment and never a fixed value

**Notes**

- This replaces the invalidation subscriber the plan asked for. A subscriber gets
  no dependency injection, because TypeORM builds it with `new target()`, and every
  write whose invalidation matters arrives from a query builder with no row id. It
  would have fired on all of them and been able to act on none.
- A convention asks everyone to remember. This fails the build when a third site
  appears without an invalidation, which is the outcome the subscriber was supposed
  to give. Verified by planting a bump in `DeviceService` and watching it fail.

## perf: serve authorization from cache

Phase 17b. Intended commit: `perf: serve authorization from cache`

**Tasks**

- [x] Cache the permission names under `role:<role>`, TTL 600s
- [x] Drop the entry when a role's grants are rewritten, after the commit

**Notes**

- Cached **per role**, not per user: one entry serves every holder, and invalidating
  is one delete. `CacheService` has no pattern delete on purpose, so a per-user key
  would have turned every role change into a scan of the user table.
- A role with nothing granted is cached like any other answer, because a plain user
  is the common case and an empty array is a value rather than a null. An absent
  role is not cached at all: `cacheKey` drops an empty part, so it would be filed
  under a bare `role` key.
- `forRole` resolved in the strategy, not the guard, so it is one read per request
  rather than one per guarded route.

## perf: serve authentication from cache

Phase 17b. Intended commit: `perf: serve authentication from cache`

**Tasks**

- [x] Cache the claims under `user:<id>`, TTL 60s, and read them in the strategy
- [x] Select six named columns, so the password hash is never read
- [x] Drop the entry after the write that changed it

**Notes**

- The projection omits the password hash on purpose. Caching the row the strategy
  reads would put every bcrypt hash in redis, which is offline cracking material in
  a store that is usually less protected than the database it duplicates.
- The cache delete is **after** the transaction, and that ordering is the whole
  point of `runThenInvalidateAuthCache`. A delete inside the transaction lets a
  request arriving before the commit refill the entry from the old snapshot, and
  that entry then outlives the token it wrongly admitted. Small window, silent
  failure.
- No try/catch here. cache-manager already turns a failing store into a miss, and a
  local catch would also swallow a genuine failure from the loader.
- No email lookup and no per-user permission key; both are explained in the plan.

## feat: block login temporarily after repeated failures

Phase 17a. Intended commit: `feat: block login temporarily after repeated failures`

**Tasks**

- [x] Count failures per address in redis, so the count holds across replicas
- [x] Block for a minute at five failures, a minute more per further failure,
      capped at fifteen
- [x] Answer 429 with `Retry-After` and nothing else about the wait
- [x] Notify the owner once per lockout, never for an unregistered address
- [x] Fail open when redis is unreachable

- The numbers are constants rather than environment variables, matching how the
  mail buckets were done. That is a departure from the rest of the
  configuration, and it is a decision worth revisiting if a deployment needs to
  tune the lockout without a release.
- The body of the 429 deliberately omits the remaining time and the header carries
  it, because a body naming the time left is a progress bar for somebody guessing
  a password.
- Failures are counted for addresses that do not exist. Counting only real
  accounts would make the status code answer which addresses exist, which is the
  question the enumeration floor exists to keep closed. The cost is that anybody
  can lock an address out by guessing it wrong.
- Redis keys carry a digest of the address rather than the address, so an
  operator with read access does not acquire a mailing list.

## docs: mark phase 17a permission authorization as done

Phase 17a. Intended commit: `docs: mark phase 17a permission authorization as done`

**Tasks**

- [x] Mark the phase done and tick its tasks in the plan
- [x] Record what the phase found rather than built

- The two findings are the reason this entry is longer than a status flip. The
  per-address rate limits had never been enforced, and `account-locked` had been
  sitting in the template registry without a caller since Phase 14.

## fix: apply the per-address rate limits that were never enforced

Phase 17a. Intended commit: `fix: apply the per-address rate limits that were never enforced`

**Tasks**

- [x] Declare every named bucket in the throttler module options
- [x] Gate each one behind a `@RateLimit` marker so it applies to opted-in routes
- [x] Key both email buckets on the submitted address

- `ThrottlerGuard` builds its list from the module options and nothing else, then
  loops over that whole list on every request. A bucket named only in
  `@Throttle()` metadata is never reached, so the three-per-hour per-address mail
  limit configured in Phase 14 had been enforced by nothing. It was written, tested
  and documented.
- The polarity is opt-in because declaring the buckets globally otherwise puts the
  mail limit on every endpoint in the application.
- The route-level limit and the module-level limit were initially declared in two
  places, and a test caught it: `@Throttle` overrides the module value, so two
  sources of the same number drift. The numbers now live in one place.

## feat: share the rate limit across replicas

Phase 17a. Intended commit: `feat: share the rate limit across replicas`

**Tasks**

- [x] Add a throttler storage over the existing redis client
- [x] Count and decide in one atomic step
- [x] Block for the rest of the window once exceeded
- [x] Fail open when redis is unreachable

- The decision is a Lua script rather than a read and a write, because the race
  is the bug: two requests read the same count, both write the next value, both
  are allowed. That is the burst an attacker sends.
- The counter resets when a block is set. Without that the counter is still above
  the limit when the block lifts, the next request re-blocks, and a temporary
  lockout becomes permanent. Verified against a real redis rather than reasoned
  about.
- A request that arrives while blocked does not extend the block, or a client
  polling in a loop is never released.

## feat: kill every access token on logout everywhere

Phase 17a. Intended commit: `feat: kill every access token on logout everywhere`

**Tasks**

- [x] Add a `sessionsVersion` column, incremented on logout everywhere and on a
      password reset
- [x] Carry it in the access token and compare it in the strategy
- [x] Accept a token with no claim only while the user is still at zero

- A permanent lockout would have been simpler and wrong: anyone can sign out a
  victim's account, and the owner is the person least able to fix it.
- A token issued before the column existed is accepted only while the user's
  version is zero, meaning nothing has asked for their sessions to die. Strict
  equality would sign out everyone on deploy, to protect a fifteen minute token
  that expires on its own.

## feat: list and revoke sessions

Phase 17a. Intended commit: `feat: list and revoke sessions`

**Tasks**

- [x] `GET /auth/sessions`, listing live refresh sessions with their device
- [x] `DELETE /auth/sessions/:id`, revoking one session and not the others

- A session is one live refresh token, not one device. Rotation leaves a chain of
  revoked rows behind exactly one live row, and one device can hold several.
- Revocation is scoped to the caller, and an id that is not theirs answers exactly
  as one that does not exist, because "not yours" confirms the id is real.
- There is no "is this my current session" flag. The access token carries neither
  a device nor a token id and the refresh token travels in the body, so the server
  cannot tell. The client already holds the token and can match the id itself.

## feat: enforce permissions in the guard

Phase 17a. Intended commit: `feat: enforce permissions in the guard`

**Tasks**

- [x] Rewrite the guard to check the caller's set, denying by default
- [x] Apply `@Permissions()` to seven routes so the decorator has real callers

- Deny by default means an ordinary user holds nothing, so a route that names a
  permission refuses rather than admits anybody who has not been granted it. An
  unseeded permission locks a route instead of unlocking it.
- The guard throws a 403 naming the missing permission instead of returning
  false, which would be a bare 403 that tells an operator nothing about what to
  grant.
- The three permissions that cannot be undone from the admin screen sit behind the
  super administrator role.

## feat: add the permission model

Phase 17a. Intended commit: `feat: add the permission model`

**Tasks**

- [x] Add `Permission` and `RolePermission` with a unique pair
- [x] Seed the permission set each role starts with
- [x] Declare the catalogue and the grants together

- The plan assumed a permission system existed. It did not: there was no table,
  no entity, the decorator had no caller, and the guard returned true for every
  route.
- The unique index on the pair is what makes the seed idempotent. The first
  version reported every grant as new on every run, because a driver reports the
  rows it attempted rather than the ones the database kept.

## docs: split phase 17 into a permission phase and a cache phase

Intended commit: `docs: split phase 17 into a permission phase and a cache phase`

**Tasks**

- [x] Split the phase in two, releasable separately
- [x] Record the tasks that describe work already done or never needed

- The permission work is a feature and the cache work is a performance change.
  Bundled into one phase they could not be released independently.
- `wrapOrLoad()` was dropped: `CacheService.wrap()` already coalesces concurrent
  callers and already stores a nullish result for the short TTL.
- `token:revoked:<jti>` was dropped: there is no per-access-token revocation to
  cache. Refresh tokens carry `revokedAt` and access tokens die through the
  version claim.
- The health task was not an addition but a change: the indicator already existed
  and reported `down`.

## fix: cascade user devices and two-factor secrets on user delete

Phase 16. Intended commit: `fix: cascade user devices and two-factor secrets on user delete`

**Tasks**

- [x] Cascade `user_devices` and add the missing constraint on `two_factor_secrets`

- `two_factor_secrets` declared the column without a relation, so TypeORM generated
  no constraint at all and a hard-deleted user left the secret behind forever.
- `user_devices` was `NO ACTION`, so deleting a user who still had a device raised
  a foreign key violation, at three in the morning, from a job nobody was watching.

## feat: add background job queue with in-process fallback

Phase 15. Intended commit: `feat: add background job queue with in-process
fallback`

**Tasks**

- [x] `@nestjs/bullmq` as an optional dependency, resolved through
      `loadOptional`, not a static import
- [x] `src/modules/queue` with a provider-level abstraction so the module imports
      cleanly when the package is absent
- [x] Four queues: `mail`, `notification`, `maintenance`, `digest`
- [x] The mail send moved into `processors/mail.processor.ts`
- [x] `retry.policy.ts`: exponential backoff, 5 attempts
- [x] Provider 4xx marked non-retryable; only timeouts, 5xx and connection errors
      are retried
- [x] Exhausted jobs sent to a dead-letter list in Redis
- [x] An in-process fallback under a bounded concurrency limiter
- [x] An idempotency guard on `template + recipient + subject id`, using a Redis
      `SET NX` with a TTL matching the retry window
- [x] Cron entry points, disabled by `QUEUE_ENABLED=false`

Implementation note: the fallback calls the same processor function the queue
does, so there is one implementation of the work and not two that drift.

**Decisions worth carrying forward**

- **`bullmq` is a dev dependency, not a runtime one.** The adapter has to be
  tested against the real library; a queue adapter that has never run is one that
  is broken. Production still ships without it unless the queue is enabled.
- **Deduplication sits around the processor, not at `enqueue`.** A queue is
  at-least-once and the duplicate arrives at _execution_. A key is also released
  when a job fails retryably, because holding it would make the retry skip itself,
  bullmq record success, and the mail never be sent. Verified against a real
  redis.
- **A redis outage fails open.** Losing a dedupe key risks a duplicate; refusing
  the job would lose a real email.
- **The dead-letter list is redis, not a table.** It is operational data read at
  3am and worthless after a few days; a table would mean something the retention
  phase has to remember to purge.
- **`ScheduleModule` was added but no cron entry uses it yet.** The only recurring
  work is the retention job, which arrives in the next phase. Entries will not be
  gated on the queue driver, so they keep running when redis is down.
- **A redis key prefix gap from the cache foundation was found and fixed here:**
  the raw client did not namespace keys the way keyv does for the cache, so every
  dedupe and dead-letter key would have been written unprefixed.

**Expected outcome**

- `register()` returns without waiting for SMTP.
- A BullMQ redelivery cannot produce a duplicate welcome email.
- Turning the queue off is a config change, not a code change.

---

## feat: add mail, notification, queue and retention configuration

Phase 13. Intended commit: `feat: add mail, notification, queue and retention
configuration`

**Tasks**

- [x] `src/configs/mail.config.ts` — transport, from name, reply-to, connection
      options, timeouts
- [x] `src/configs/notification.config.ts` — per-channel enable flags and
      credentials
- [x] `src/configs/queue.config.ts` — enabled, redis url, attempts, backoff,
      concurrency
- [x] `src/configs/retention.config.ts` — every age and batch size
- [x] `src/configs/password-policy.config.ts`
- [x] `APP_URL` added to `app.config.ts`; every email links back to it
- [x] A `redis` namespace for queue and throttle usage, distinct from the cache
      namespace so keys never collide
- [x] `env.validation.ts` extended: in production `MAIL_FROM` is required,
      `MAIL_TRANSPORT` must not be `memory`, `APP_URL` must be an absolute https
      URL
- [x] Every new variable documented in `.env.example` and
      `src/configs/README.md`

Implementation note: a validation rule that only fires in production is
`superRefine` on the zod schema, not a check inside the service, so a bad deploy
fails at boot instead of at the first email.

**Expected outcome**

- No hard-coded value anywhere in the new modules.
- A misconfigured production environment is rejected at startup with a message
  naming the variable.

---

## feat: define the retention policy table

Phase 16. Intended commit: `feat: define the retention policy table`

**Tasks**

- [x] One entry per table, each with its own predicate
- [x] Keep a deferred list so the gap is reviewable

- The policy is data rather than a switch statement, so adding a table is adding
  an entry and each predicate is testable without a database.
- Four tables named in the plan have no table yet. They are listed as deferred
  rather than left out, because a rule naming a missing table would fail on every
  run.

## feat: add batched retention deletes

Phase 16. Intended commit: `feat: add batched retention deletes`

**Tasks**

- [x] Delete in batches, one transaction each, with a pause between
- [x] Add a dry run that counts and deletes nothing
- [x] Stop on the run timeout rather than finishing the batch in progress

- A query runner returns the tuple `[entities, affected]` for a statement with
  `RETURNING`, not the deleted rows. Reading the array length counts two for every
  delete, which either loops until the timeout or stops after the first batch,
  silently, depending on the batch size.
- A failed target is recorded and skipped rather than ending the run. One renamed
  column should cost a skipped table, not a week of uncollected data.

## feat: add the maintenance run log

Phase 16. Intended commit: `feat: add the maintenance run log`

**Tasks**

- [x] Add an append-only run log with no index
- [x] Record the per-target detail so the history can be read without a chart

- A run is about 728 bytes stored, so a year of nightly runs is roughly 260 KB.
  An index would be the only index on the table and would cost more than it saves.
- The migration also tried to alter a column from the previous phase, because a
  default declared as a callback does not compare equal to what the driver reads
  back. Every later migration would have carried the same two lines.

## feat: add the maintenance job processor

Phase 16. Intended commit: `feat: add the maintenance job processor`

**Tasks**

- [x] Run the policy as a queue job and record the run
- [x] Share one execution path between the schedule and the admin route

- The processor sits below the queue in the module graph and the scheduler above
  it, which is why the scheduled entry is a separate module rather than a member
  of the same one. The alternative was `forwardRef`, which hides a loop rather than
  removing it.
- A run that finished is a success even when individual targets failed: a renamed
  column answers a retry identically five seconds later. A timeout is the opposite
  and stays retryable, because tables were left unclean.

## feat: schedule the retention job

Phase 16. Intended commit: `feat: schedule the retention job`

**Tasks**

- [x] Schedule the nightly run through the job queue
- [x] Default `RETENTION_ENABLED` to true

- Registered with `SchedulerRegistry` and a script built at bootstrap, because the
  decorator needs its expression as a literal at the moment the class is defined.
- A malformed schedule is logged and the job is not scheduled, rather than
  throwing out of bootstrap over a typo in an environment variable.
- The schedule does not catch up a missed run. Restarting is fine because the
  schedule is re-registered on every boot, but a process that is not running at
  that minute loses the night, and nothing logs it.

## feat: expose retention runs to an admin

Phase 16. Intended commit: `feat: expose retention runs to an admin`

**Tasks**

- [x] A dry run that answers synchronously, and a real run that is queued
- [x] Read the history
- [x] Require a permission for the two routes that change data

- The dry run is synchronous because counting is fast enough to answer inside a
  request and an operator rehearsing against production data wants the numbers
  now. A real run is queued because batching can take minutes.
- The two write routes need `maintenance:run` while the read routes stay at the
  manager level, so reading the history does not carry the ability to delete
  every user in the database.

## docs: licence, contributor and security documentation

Intended commit: `docs: add licence, contributing guide, security policy and roadmap`

**Tasks**

- [x] Add a licence
- [x] Add a contributing guide
- [x] Add a security policy
- [x] Add a roadmap with enhancement plans
- [x] Add this changelog, written per commit
- [x] Rewrite the README to introduce the project

- `LICENSE` is MIT. The boilerplate is meant to be forked and used, and a licence
  that discourages that makes the whole exercise pointless.
- `SECURITY.md` records what is in scope and where to report privately, and lists
  the known limitations that matter for a real deployment: per process rate
  limits, the unguarded `GET /users/:id`, the two-factor key that has a default,
  and the compose stack that uses development secrets.
- `ROADMAP.md` separates the three open decisions from the enhancement plans, so
  an undecided question is not read as a feature that already exists. Each plan
  carries what it would cost, and the ones that are cheap to get wrong, such as
  caching authorisation claims or deleting a large table in one statement, say so
  at the point where someone would otherwise just do it.
- The README is rewritten to introduce the project rather than to describe the
  Nest starter it replaced, and it links to the folder readmes so an explanation
  is where you are already looking.

## test: build the platform app per branch so the types resolve

**Tasks**

- [x] Make the cross platform middleware spec type check

**Files**

```text
src/common/middlewares/request-id.middleware.spec.ts
```

- The cross platform middleware test built its application with
  `{ adapter: useFastify ? new FastifyAdapter() : undefined }`, which is a union
  the two `NestFactory.create` overloads both reject, so the spec file did not
  type check even though the tests passed.
- Each branch now calls `create` with the shape that branch actually uses. A test
  that runs but does not compile is a broken test: it stops anyone running
  `npm run typecheck`, which is one of the four checks CI performs.

## chore: enforce commit messages and staged formatting with husky

**Tasks**

- [x] Add husky
- [x] Add commitlint
- [x] Add lint-staged
- [x] Add a commit convention check
- [x] Add a staged formatting check
- [x] Add a `check` script running the same steps as CI
- [x] Record `license`, `author`, `repository`, `engines` and `packageManager`
- [x] Add a description and keywords for the package

**Files**

```text
.husky/commit-msg
.husky/pre-commit
commitlint.config.mjs
package.json
package-lock.json
.gitignore
```

- husky writes to `.husky/_`, which is gitignored. `npm install` restores the
  hooks through the `prepare` script, so a fresh clone has them without a manual
  step.
- commitlint follows Conventional Commits, with the subject pinned to lower case
  so the history keeps the style it already has instead of each message choosing
  its own. A malformed message fails the commit rather than waiting for CI.
- lint-staged runs Prettier and `oxlint --fix` on staged files only, so a commit
  never reformats work that is not part of it.
- `npm run check` runs the four steps CI runs, in the same order, so the whole
  gate is available locally in one command.
- `package.json` was `UNLICENSED` with an empty description and no repository, so
  a published package of this template would have said nothing about where it
  came from or what it was.

## docs: move implementation notes from the plan into folder readmes

**Tasks**

- [x] Remove implementation notes from `PLAN.md`
- [x] Add a README to `src/configs`
- [x] Add a README to `src/database`
- [x] Add a README to `src/common`
- [x] Add a README to `src/core`
- [x] Add a README to `src/core/health`
- [x] Add a README to `src/core/logger`
- [x] Add a README to `src/core/swagger`
- [x] Add a README to `src/modules`
- [x] Add a README to `src/modules/auth`
- [x] Add a README to `src/modules/users`
- [x] Add a README to `src/modules/admin`
- [x] Point `PLAN.md` at the readmes

- The implementation notes were removed from `PLAN.md`, which now holds only the
  phases, their status, the progress table and the follow-up candidates.
- The previous layer readmes listed files that do not exist: `redis.config.ts`,
  `RequestIdInterceptor`, `TimeoutInterceptor`, and the `exceptions` and
  `serializers` directories. All of that was aspirational and misleading, and it
  is now either real or gone.
- Two previously invisible decisions are recorded rather than implied: rate limits
  are counted per replica, and `GET /users/:id` is readable by any authenticated
  user.

## chore: add production hardening foundation

**Tasks**

- [x] Add rate limiting
- [x] Add security headers
- [x] Add CORS config
- [x] Add request id
- [x] Add structured logging
- [x] Add health check
- [x] Add graceful shutdown
- [x] Add environment validation
- [x] Add seed command
- [x] Add migration command
- [x] Add CI workflow
- [x] Add Dockerfile
- [x] Add docker-compose for local development

**Files**

```text
src/configs/security.config.ts
src/configs/cors.config.ts
src/configs/throttler.config.ts
src/configs/env.validation.ts
src/common/middlewares/request-id.middleware.ts
src/common/middlewares/catch-all-route.util.ts
src/common/utils/request-id.util.ts
src/core/logger/app.logger.ts
src/core/health/health.module.ts
src/core/health/cache.health.ts
src/core/health/shutdown.service.ts
src/database/data-source.ts
src/database/seed.ts
src/database/seeds/
src/database/migrations/
docs/production.md
Dockerfile
docker-compose.yml
.github/workflows/ci.yml
```

- Rate limiting is a global `ThrottlerGuard`, so a new endpoint is limited from
  the moment it exists. The credential routes override it with `@Throttle`,
  because 100 per minute is no defence at all for a route that accepts a
  password: login is 5 per minute, the TOTP routes 5 per 5 minutes, since a six
  digit code is 1 in a million. Counters are in process memory, so with several
  replicas the limit is per replica.
- CORS defaults to same-origin only and `credentials` to false, since this API
  authenticates with a bearer token rather than a cookie. Validation rejects
  `CORS_CREDENTIALS=true` together with a wildcard, because browsers refuse that
  pairing anyway and a config that only appears to work is worse than one that
  fails.
- A request id is reused from the client only when it is 8 to 64 characters of a
  restricted charset. The id lives in an `AsyncLocalStorage`, so logs from deep
  inside a service correlate without the call site knowing about requests.
  Measured with a raw socket, Node's HTTP parser rejects a newline in a header
  with a 400 before any handler runs, so the charset rule is defence in depth
  rather than the thing standing between a caller and a forged log line.
- The middleware is platform independent. `header()` is the one spelling both
  Express and Fastify have, and `catchAllRoute` picks the wildcard per adapter,
  because `path-to-regexp` v8 and `find-my-way` spell a catch-all differently and
  neither accepts the other's. Tested on both adapters with a real HTTP server.
- Logging is one JSON object per line in production, with the request id
  included when there is one. Development keeps Nest's own logger, which is
  coloured and prints how long each module took to initialise, and that number is
  lost the moment output becomes JSON.
- Health checks are split into liveness and readiness. Liveness touches nothing
  external, because a failing liveness probe makes an orchestrator restart every
  healthy instance at the exact moment a dependency is down.
- The cache health check writes a random value and reads it back. A plain read
  would report healthy on a dead cache, which is the same trap that made
  `CacheService.isHealthy()` impossible.
- Environment validation reports every problem at once. It is strict in
  production, where a secret that still holds the `.env.example` value counts as
  unset, and lenient in development so a placeholder does not block local work.
  The schema is `zod`; its own messages are kept, and messages are written only
  for the `refine` checks where zod would otherwise say nothing useful.
- `synchronize` is off and schema changes go through reviewed migrations.
  Entities are listed explicitly in the standalone data source, since
  `autoLoadEntities` only works inside the Nest container and a migration that
  missed an entity would silently generate an incomplete schema.
- The seed creates one admin and is idempotent. With no `ADMIN_PASSWORD` it
  generates a 24 character password and prints it once, and checks for an
  existing admin before generating anything, so a second run stays silent rather
  than printing a password that will not work.
- The Docker image is a two stage build running as the `node` user, and its
  healthcheck uses the liveness endpoint so a database problem cannot get the
  container restarted.

## feat: add redis cache foundation

**Tasks**

- [x] Add Redis config
- [x] Add cache module
- [x] Add cache service abstraction
- [x] Add cache key constants
- [x] Add cache decorators/helpers if needed

**Files**

```text
src/configs/cache.config.ts
src/core/cache/cache.module.ts
src/core/cache/cache.service.ts
src/core/cache/cache-keys.ts
```

- Uses `@nestjs/cache-manager` with Keyv, and `@keyv/redis` for Redis and
  Valkey. Both talk the same protocol, so only `backend` differs between them.
  `CACHE_URL` is the whole connection configuration, including credentials, TLS
  and database, which is what the Redis client takes anyway.
- Exactly one store. `CACHE_BACKEND=memory` is an explicit choice for local
  development, never a silent fallback, so a configured but unreachable cache
  fails the boot instead of quietly serving per-instance data. The two store
  layout that `@nestjs/cache-manager` documents was rejected after measurement:
  memory first means the shared store is written but never read, and Redis first
  with a memory fallback resurrects values that were just deleted, because the
  delete only reached the shared store.
- An unreachable cache fails the boot, through a `store.get('__startup__')` probe
  with `throwOnErrors` on, since a Keyv store connects lazily and the app would
  otherwise start and fail on the first request. Errors are switched off after
  the probe so a later outage is a miss rather than a 500.
- `CacheService.wrap()` is the miss handler and the failover back to the
  database. It delegates to cache-manager, which already supplies request
  coalescing and stale while revalidate, so neither is reimplemented here.
  Measured on Valkey: 300 concurrent requests on one hot key cause 1 loader call;
  a read inside the refresh threshold returns in 80ms while the loader takes
  200ms, and the refreshed value appears afterwards.
- Nullish results are cached for `CACHE_EMPTY_TTL` rather than the full TTL, so
  repeated lookups of something missing stop hammering the loader while a record
  created afterwards still appears quickly. This does not help a client
  enumerating many different missing ids, since each is a separate key.
- Expirations carry a 10% jitter, so a bulk write does not put every entry on
  the same deadline and expire them in one burst.
- `disableOfflineQueue` is set on the client, so a command issued while the
  socket is reconnecting reports a miss instead of waiting for the outage to end.
  It does not remove the cost of a dead cache: the store re-attempts the
  connection on every operation, and each attempt waits out
  `CACHE_CONNECT_TIMEOUT`. Measured against an unreachable cache with the default
  2000ms, one request costs 4003ms, because the read misses and the write back
  fails. Concurrent requests for the same key still share a single loader run, so
  the outage costs latency rather than correctness.
- Invalidation is by explicit key only. There is no `deleteByPattern`, because
  scanning a keyspace is unbounded on a shared server and a broad pattern fails
  silently.
- Authentication state is not cached, so a role change or a deactivation takes
  effect on the next request instead of after a TTL.

## feat: add two-factor authentication foundation

**Tasks**

- [x] Add 2FA secret storage
- [x] Add 2FA setup endpoint
- [x] Add 2FA verify endpoint
- [x] Add 2FA login flow
- [x] Add recovery code support if needed

**Files**

```text
src/modules/auth/entities/two-factor-secret.entity.ts
src/modules/auth/two-factor.service.ts
src/modules/auth/dto/two-factor-*.dto.ts
src/common/utils/encryption.util.ts
src/common/utils/recovery-code.util.ts
src/configs/two-factor.config.ts
```

- TOTP via `otpauth`, QR codes via `qrcode`.
- The shared secret is never stored in the clear. It is encrypted with
  AES-256-GCM using `TWO_FACTOR_ENCRYPTION_KEY`, and the auth tag is verified on
  read so tampered rows fail loudly. Rotating the key invalidates every stored
  secret.
- `POST /auth/2fa/setup` issues a secret but does not activate 2FA.
  `POST /auth/2fa/verify` confirms it with a code and only then enables 2FA and
  returns the recovery codes, which are shown once.
- Recovery codes are Crockford style base32, stored as salted hashes and removed
  from the list as they are spent, so the array doubles as the set still usable.
- `POST /auth/login` returns HTTP 200 with a short lived challenge token instead
  of tokens when 2FA is on. `POST /auth/2fa/login` exchanges the challenge plus
  a TOTP code or a recovery code for the token pair.
- TOTP steps are single use. The last accepted counter is persisted, so replaying
  a code inside its own 30 second window is rejected.
- Five invalid attempts locks verification for 15 minutes.
- Setting `TWO_FACTOR_ENABLED=false` turns the feature off globally, and login
  falls back to the single factor flow.

## feat: add device authentication foundation

**Tasks**

- [x] Add user device entity
- [x] Store device info during login
- [x] List devices
- [x] Revoke device
- [x] Attach refresh tokens to devices

**Files**

```text
src/modules/auth/entities/user-device.entity.ts
src/modules/auth/device.service.ts
src/modules/auth/dto/user-device.dto.ts
src/modules/auth/types/device-metadata.interface.ts
```

- Devices are fingerprinted by user agent, so repeated logins from the same
  browser or app reuse a single `user_devices` row instead of creating
  duplicates. Logging in again from a revoked device reactivates it instead of
  failing.
- Each `refresh_tokens` row carries a `deviceId`. Rotation keeps the token on its
  original device, so a session can never hop between devices while refreshing.
- `DELETE /auth/devices/:id` deactivates the device and revokes every refresh
  token attached to it (`device_revoked`).
- `logout-all` revokes all refresh tokens and deactivates all devices.
- The friendly device name is derived from the `user-agent` header by the
  `@DeviceName()` decorator, so clients never have to send anything. An explicit
  `x-device-name` header overrides it. Both sources are untrusted, so the
  decorator trims the value, collapses whitespace and caps it at the column
  width.
- `parseUserAgent()` in `common/utils/user-agent.util.ts` is a dependency free
  best effort parser. Swap it for `ua-parser-js` if exhaustive coverage matters
  more than staying dependency free.

## feat: add refresh token authentication

**Tasks**

- [x] Add refresh token entity
- [x] Add refresh token DTO
- [x] Add refresh token rotation
- [x] Add logout
- [x] Add logout all devices
- [x] Store token metadata
- [x] Revoke old refresh tokens

**Files**

```text
src/modules/auth/entities/refresh-token.entity.ts
src/modules/auth/enums/refresh-token-revoked-reason.enum.ts
src/modules/auth/refresh-token.service.ts
```

- Every login, register and refresh call stores one `refresh_tokens` row.
- Rotation happens inside a database transaction with a pessimistic row lock, so
  concurrent refreshes of the same token produce exactly one winner.
- The rotated-out token keeps a `replacedById` pointer, which forms the rotation
  chain.
- Replaying a token that was revoked by rotation is treated as theft: all
  sessions of that user are revoked. Tokens revoked by an explicit logout are not
  a compromise signal and do not trigger the sweep.

## feat: integrate Swagger for API documentation

**Tasks**

- [x] Add Swagger config
- [x] Add Swagger setup in `core/swagger`
- [x] Add auth bearer documentation
- [x] Add tags for Auth, Users, Admin
- [x] Expose docs route

- `GET /docs`, with bearer authentication documented, and tags for Auth, Users
  and Admin.
- Each endpoint declares a response DTO, so the schema is declared rather than
  inferred. `POST /auth/login` returns either tokens or a two-factor challenge,
  which is spelled out with `oneOf` in `@ApiExtraModels`.
- Content-Security-Policy is off by default, because the Swagger UI needs inline
  script and style and a strict policy blocks it.

## feat: add admin health check and enhance dashboard functionality

**Tasks**

- [x] Create `admin.module.ts`
- [x] Create `admin.controller.ts`
- [x] Create `admin.service.ts`
- [x] Prefix admin routes with `/admin`
- [x] Apply manager-only access
- [x] Add basic admin health/dashboard route

- `GET /admin/health` and `GET /admin/dashboard`, both behind `@ManagerOnly()`
  on the controller so a new route there is protected by default.

## feat: implement role-based access control (RBAC) and manager scope handling

**Tasks**

- [x] Add metadata constants
- [x] Add `@Roles()` decorator
- [x] Add `RolesGuard`
- [x] Add `@ManagerOnly()` decorator
- [x] Add `ManagerGuard`
- [x] Protect manager/admin routes
- [x] Ensure only users with `isManager = true` can access `/admin` routes
- [x] Prepare `@Permissions()` decorator placeholder for future permission system

- `@Roles()` with a global `RolesGuard`, `@ManagerOnly()` with a `ManagerGuard`,
  and `@Permissions()` prepared for a finer permission system.
- The guards read the request context rather than injecting a feature service, so
  an authorisation failure reads the same as any other failure.

## feat: implement authentication module with JWT support

**Tasks**

- [x] Create `auth.module.ts`
- [x] Create `auth.controller.ts`
- [x] Create `auth.service.ts`
- [x] Add login DTO
- [x] Add register DTO
- [x] Add password hashing utility/service
- [x] Add JWT payload interface
- [x] Add JWT strategy
- [x] Add JWT auth guard
- [x] Add `@Public()` decorator
- [x] Add `@CurrentUser()` decorator
- [x] Add `/auth/register`
- [x] Add `/auth/login`
- [x] Add `/auth/me`

- Access token signing, scrypt password hashing with a per-row salt, and the
  `JwtStrategy` behind a global `JwtAuthGuard` with `@Public()` as the opt out.
- `UserResponseDto` has no property for the password, so a response cannot leak
  it even by accident.

## feat: implement user management module foundation

**Tasks**

- [x] Create `users.module.ts`
- [x] Create `users.controller.ts`
- [x] Create `users.service.ts`
- [x] Create `user.entity.ts`
- [x] Create create/update user DTOs
- [x] Add basic user response DTO
- [x] Add `Role` enum
- [x] Add `isActive`
- [x] Add `isManager`
- [x] Add timestamps
- [x] Add soft delete column if needed
- [x] Add methods to find user by id/email
- [x] Add basic user profile route

- `User` entity with a uuid from the database, a unique lower cased email,
  `isActive` and `isManager` kept separate, and a soft delete column.
- Create, read, update and soft delete, with admin only routes guarded by
  `@Roles(Admin, SuperAdmin)`.

## feat: enhance app configuration and introduce global utilities

**Tasks**

- [x] Define app config
- [x] Define JWT config placeholder
- [x] Organize existing database config
- [x] Add global validation pipe
- [x] Add global exception filter
- [x] Add global response transform interceptor
- [x] Add common metadata constants
- [x] Add base response DTO/interface
- [x] Add request context interface

- Namespaced configuration through `registerAs`, and the global validation pipe,
  exception filters and response transform interceptor.

## chore: initialize project structure with placeholders and documentation

**Tasks**

- [x] Create `src/configs`
- [x] Create `src/database`
- [x] Create `src/common`
- [x] Create `src/core`
- [x] Create `src/modules`
- [x] Add README for each main layer
- [x] Add root `PLAN.md`
- [x] Commit architecture skeleton

- The layer structure, and the rule that `common` may not depend on business
  modules.

## Add initial database and Observe configuration setup

- `DATABASE_URL` based connection, and the optional observability integration.

## feat: outbound subscriptions

`feat(subscription): add previous secret support for rotation window` ·
`test(subscription): add unit tests for hmac sign with previous secret rotation` ·

**What changed**

- `SubscriptionEndpoint` gained `previousSecret` field, allowing an endpoint to
  keep the old secret for a short window after a secret rotation deploy
- `parseEndpoint` sets `previousSecret` from the config (defaults to `undefined`)
- `SubscriptionService.publish()` verifies the previous secret when the current
  secret fails the rotation window check, so a deploy does not break verification
  halfway through
- `isOldSecretValid()` validates an HMAC shape from a candidate secret

**Why**

Secret rotation is essential for production deployments. Without keeping the old
secret available for a grace period, a deployment that rotates the signing key
would cause every inbound event to be rejected until the new secret is propagated
to all callers. By storing `previousSecret` alongside the active `secret` and
checking it during the rotation window, the system remains available while the
new secret spreads.

---

## feat: signing and replay protection

`feat(signing): add signing service with timestamp verification` ·
`test(signing): add unit tests for timestamp verification` ·

**What changed**

- `SigningService.verifySignature()` now validates `t=<timestamp>,v1=<hmac-sha256>` format
- Replay protection: timestamps older than `maxAge` (configurable, default 10 min) are rejected
- Clock skew tolerance: `clockSkew` (configurable, default 2 min) allows minor clock differences
- Constant-time comparison via `constantCompare()` prevents timing attacks
- The verification window and signed timestamp ensure a payload cannot be forged

**Why**

Webhooks and outbound subscriptions receive user-supplied data that must be cryptographically verified. Without timestamp and signature validation, an attacker could replay old messages or forge new ones. The `t=<timestamp>,v1=<hmac-sha256>` format provides both freshness (via `maxAge`/`clockSkew`) and integrity (via HMAC-SHA256). Constant-time comparison prevents leaking information through timing differences. This is the foundation for secure webhook delivery and replay-resistant event processing.

---

## feat: SSRF guard

`feat(security): add SSRF guard service with hostname resolution and DNS rebinding protection` ·

**What changed**

- `SsrfGuardService.checkUrl()` validates URLs against a restricted address list
- DNS resolution with fallback to direct IP checks
- Blocks loopback (127.0.0.1), link-local (169.254.x.x), and private ranges
- Blocks metadata address (169.254.169.254) used by cloud metadata services
- Prevents DNS rebinding attacks by resolving hostnames and checking resolved IPs
- Configurable timeout and response size bounds (implementation detail)

**Why**

Webhooks and outbound subscriptions receive user-supplied URLs. Without SSRF protection,
an attacker could force the application to make requests to internal services,
cloud metadata endpoints (e.g., 169.254.169.254), or other restricted systems.
The SsrfGuardService resolves hostnames to IP addresses and rejects any that
fall within restricted ranges, preventing server-side request forgery. This is
essential when accepting URLs from external callers such as webhook providers.

---
