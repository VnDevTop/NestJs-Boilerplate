# Common Layer

Reusable building blocks. Nothing here may know about a business module.

```text
common
├── constants     metadata keys, header names, app wide limits
├── decorators    @Public, @CurrentUser, @Roles, @ManagerOnly, @Permissions, @DeviceName
├── enums         Role
├── filters       AllExceptionsFilter, HttpExceptionFilter
├── guards        JwtAuthGuard, RolesGuard, ManagerGuard, PermissionsGuard
├── interceptors  ResponseTransformInterceptor
├── interfaces    ApiResponse, JwtPayload, RequestUser
├── middlewares   RequestIdMiddleware
├── pagination    the cursor and the two shapes a paged response has
├── query         the query layer: a spec, a criteria, and the SQL they produce
├── search        the search language: a tokenizer, a parser and a tree
├── pipes         global validation pipe
└── utils         password, encryption, recovery codes, user agent, request id
```

## Rules

- No imports from `modules`. If something here needs business data, it takes it
  from the request instead.
- Guards read the request context rather than injecting a feature service. A
  guard that loads users to check a role is a guard that can fail in a way the
  caller cannot interpret.
- Metadata keys live in `constants/metadata.constants.ts`, never as inline
  strings, so a rename cannot leave a decorator and its guard disagreeing.
- A utility that is only ever used by one module belongs in that module.

## Middleware

`RequestIdMiddleware` gives every request an `X-Request-Id` and keeps it in an
`AsyncLocalStorage`, so a log written deep inside a service can correlate without
the call site knowing anything about requests.

A caller supplied id is reused only when it is 8 to 64 characters of a restricted
charset. A newline in that value would let a caller forge or split log entries.
Node's HTTP parser rejects such a header with a 400 before it reaches a handler,
so this is defence in depth rather than the thing standing between a caller and
a forged log line.

The middleware is platform independent. Express and Fastify share no request or
reply type, so it declares the parts it uses itself and sets the header with
`header()`, which is the one spelling both have. `catchAllRoute` picks the route
pattern per adapter, because `path-to-regexp` v8 and `find-my-way` spell a
catch-all differently and neither accepts the other's.

## Filters

`HttpExceptionFilter` shapes anything the application threw on purpose, and
`AllExceptionsFilter` catches the rest and logs it, and reports it to Sentry when
`@sentry/node` and a DSN are present — with the request headers, cookies, body and
query string stripped, because that is where credentials arrive. A 4xx is not logged: it is a
client mistake, and logging every one buries the failures that matter.

## Interceptors

`ResponseTransformInterceptor` wraps successful responses in the standard
`ApiResponse` envelope, so the shape is decided in one place.

A listing route returns a `PaginatedResultDto` and the interceptor lifts its
`meta` to the top of the envelope:

```json
{
  "success": true,
  "data": [],
  "meta": { "nextCursor": null, "hasMore": false, "limit": 20 },
  "timestamp": "2026-10-03T03:17:01.234Z"
}
```

`data` is the array the route has always returned, so a client reading `data`
needs no change; `meta` is the new part. A route that is not paged has no `meta`
at all — absent rather than null, so it cannot be confused with an empty page.

## Pagination

`pagination/` is the floor the rest of the plan stands on: every group after this
one stores data, and every one of them needs a list route that pages. It knows no
entity, and it holds three decisions.

| File                             | Decision                                                            |
| -------------------------------- | ------------------------------------------------------------------- |
| `cursor.ts`                      | the boundary is opaque base64url, versioned, and a bad one is a 400 |
| `cursor-pagination-query.dto.ts` | `limit`, `cursor`, `sort`, `order` — and no `page`                  |
| `paginated-result.dto.ts`        | the page and its `meta`, which the envelope carries                 |

**Keyset, not offset.** `LIMIT n OFFSET m` makes the database count and discard
`m` rows per page, so page 900 reads nine hundred rows to return twenty — and
because that count happens inside the statement, a row inserted between two
requests can appear on both pages or on neither. A cursor names the boundary it
stopped at, so an insert ahead of the reader cannot move it. This is asserted as a
test in `query/read-page.spec.ts`, not only described here.

**The boundary is `(sortColumn, id)`, compared as a tuple.** `createdAt` is not
unique — many rows share a timestamp — and Postgres owes no ordering to equal keys,
so a boundary on the sort value alone would either re-read or skip the rows that
tie with it. The id is the tie-break, and it is also what makes `hasMore` and the
next cursor unambiguous.

**`hasMore`, not a total.** One row past the limit answers it for free; `COUNT(*)`
answers it by reading every matching row, and goes stale between pages anyway.

**A malformed cursor is refused.** Ignoring it would answer a request for page four
with page one: a correct-looking response to the wrong question, which a client
renders as "no results".

## The query layer

`query/` is where a request becomes a query. It is the answer to "adding a list
route needs no new pagination code", and it holds four decisions.

| File                | Decision                                       |
| ------------------- | ---------------------------------------------- |
| `query-spec.ts`     | a route's whole query surface, in one object   |
| `query-criteria.ts` | the request as data: filters, sort, page       |
| `build-criteria.ts` | a DTO plus a spec becomes a criteria           |
| `apply-criteria.ts` | a criteria becomes SQL, with every value bound |
| `read-page.ts`      | the one call a list route makes                |

**A route declares a spec; a service calls one function.** The spec says which
fields may be filtered and sorted and which column each one means. The DTO says
what the request may contain. The service says "give me a page of this". There is
no query builder in the service, no filter loop, and no `hasMore` arithmetic.

```ts
const criteria = buildCriteria(query, USER_QUERY_SPEC);

const page = await readPage({
  query: this.usersRepository.createQueryBuilder('user'),
  criteria,
  alias: 'user',
});
```

**The spec is the allow-list, and it is checked against the DTO.** A filter in the
spec that the DTO does not declare is a compile error, and so is a DTO property
that no filter declares. The first would be a filter that can never fire; the
second is a parameter the client can send and the route ignores — a client that
asks for the inactive accounts and gets the unfiltered list has been told a lie,
and nothing in the code says the filter was forgotten.

**The operator comes from the spec, never from the request.** A request says
_what_ to filter by, not _how_. The set of operators is closed, and each one is a
literal in `apply-criteria.ts` — there is no general-purpose "expression"
operator, because the mechanism is safe precisely because the set of shapes it can
produce is finite and each one is written out by hand.

**Every value is bound.** The SQL text carries column names and comparison
operators, both from the spec, and never a value. A value reaches Postgres as a
parameter, which is the only place a value can go without being able to change
the meaning of the statement.

**The columns are qualified with the alias.** An unqualified column is ambiguous
the moment the query joins a second table, which is exactly what a future route
on the same entity will do.

**The scope is not a filter.** `GET /auth/devices` answers "your own devices", and
that is applied by the service to the query builder, not by anything the client
sends. A filter the client controls and a scope the server decides are different
things, and the code says which is which.

### Adding a listing route

1. Extend `CursorPaginationQueryDto` with the filters, as declared properties.
   A DTO that accepted a `{ [column]: value }` bag and passed it to TypeORM
   would let a caller read any column the entity has, `password` included.

2. Declare the route's query surface:

   ```ts
   export const ORDER_QUERY_SPEC = defineQuerySpec<ListOrdersQueryDto>({
     filters: {
       reference: { column: 'reference', operator: 'eq' },
       customer: { column: 'customerName', operator: 'ilike' },
     },
     sort: {
       createdAt: 'createdAt',
       reference: 'reference',
     },
     defaultSort: 'createdAt',
   });
   ```

   Every sortable column must be `NOT NULL` — a cursor carries its boundary as a
   string, and `null` would have to be encoded as something the decoder reads as
   malformed. That restriction is the reason nullable columns are absent from
   these maps, and it is why adding one is a deliberate change rather than a line.

3. `buildCriteria(query, SPEC)` and `readPage({ query, criteria, alias })`.

4. Add an index that leads with the sort column and carries the id immediately
   after it — `(createdAt, id)`. Ascending only; Postgres scans an index backwards
   for the other direction.

The only thing this buys that matters is the last one: **Phase 24 is a no-op for
every route that follows this one.** Adding a list route after this phase needs no
new pagination code.

## The search language

`search/` is where a search box's text becomes a tree. It holds the tokenizer, the
parser and the tree, and **nothing else** — no entity, no column, no database.

| File                 | Decision                                                    |
| -------------------- | ----------------------------------------------------------- |
| `ast.ts`             | the eight shapes a parsed query can take                    |
| `tokenizer.ts`       | the words, and the escapes that make a colon literal        |
| `parser.ts`          | recursive descent, one method per precedence level          |
| `errors.ts`          | the errors, and the position in the query they point at     |
| `field-registry.ts`  | the fields an entity may be searched by, and the allow-list |
| `translators/`       | postgres, in-memory and a mock                              |
| `search.test-kit.ts` | the assertions every entity's search has to pass            |

```ts
const query = parseSearchQuery('email:ada AND role:admin');
```

**The grammar.**

```text
or      := and ( OR and )*
and     := not ( AND? not )*
not     := NOT not | primary
primary := '(' or ')' | field-value | term | phrase
```

`NOT` binds tightest, then `AND`, then `OR`. The operator between two adjacent
terms is **AND**, where Lucene's classic parser defaults to OR: this is a filter
over a table somebody is typing into, and a query that widens with every word
returns the whole table.

**What it understands.** `term`, `field:value`, `"phrase"`, `AND` `OR` `NOT`
(uppercase only, so `and` can be a term), parentheses, `[a TO b]` inclusive,
`{a TO b}` exclusive, `>` `<` `>=` `<=`, `wild*`, `f?y`, `term~`, `term~2`,
`term^3`, `field:*`, and `\:` for a literal colon.

**What it refuses, and why.** Not because the three are hard — because a
translator that has to produce one of them cannot be proved to produce the thing
the user asked for, and a search that answers a different question is worse than
one that says it cannot.

| Refused                   | What it looks like | Why                                                                                           |
| ------------------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| regular expressions       | `/foo/`            | a regex is a different question from a term, and searching for the text `/foo/` finds nothing |
| scripts and pseudo-fields | `_script:x`        | a translator cannot produce a computed field                                                  |
| nested queries            | `title:(a OR b)`   | a group inside a value is a query inside a query                                              |

**The tree knows no entity.** A field is a name and nothing more: which column it
lands on, whether it may be searched at all and what it weighs are the field
registry's business, and the registry is Phase 28. That is what makes adding
search to another entity one field-map file and no new infrastructure.

**Every failure is a `SearchParseError`,** with the position in the query. A
malformed query is a client mistake, and a client mistake must be a 400 that says
which part was wrong — not a `TypeError` from inside the parser, which is a 500
for a request that was merely wrong.

### The field registry

`SearchFieldRegistry` maps a field name to the six facts a translator needs:

```ts
const USER_SEARCH_FIELDS = new SearchFieldRegistry(
  {
    email: {
      type: 'text',
      searchable: true,
      filterable: true,
      sortable: true,
      weight: 1,
      column: 'email',
    },
  },
  { defaultField: 'email' },
);
```

**The allow-list is the injection boundary.** A field name is the client's input,
and the only way it can reach SQL is by being looked up here first. An undeclared
name is an `UnknownFieldError` that lists the names that do exist — never a field
silently dropped, because a dropped field is a filter the client believes is
applied and is not.

**The column is the one piece of a search that becomes SQL text.** Everything else
is a parameter, and a parameter cannot change the meaning of a statement. An
identifier cannot be bound, so the column is interpolated — and so the registry
refuses a column that is not a plain identifier. A field map that accepted
`"email" ; DROP TABLE users` would be a field map that had handed a client the
database.

**The type decides whether a term is a match or a comparison.** A text field is
matched as a substring and has to be searchable; every other type is compared for
equality and has to be filterable.

### The translators

| Translator             | Answers                                             |
| ---------------------- | --------------------------------------------------- |
| `translateToSql`       | the SQL and the values to bind with it              |
| `translateToPredicate` | whether a row matches — the reference semantics     |
| `MockSearchTranslator` | whatever it was told to, and it records the queries |

**Every value is a parameter.** The SQL text carries column names and operators
and nothing else.

**The in-memory translator is the reference.** It answers with nothing but
JavaScript, so the answer can be checked by hand, and a Postgres translator that
disagrees with it is answering a different question.

### The test kit

`search.test-kit.ts` holds the assertions every entity's search has to pass, so
an entity's spec is one call:

```ts
it('holds the search properties', () => {
  runSearchTestKit({ registry: USER_SEARCH_FIELDS });
});
```

**The golden cases are derived from the registry**, so they are about the search
rather than about the entity. **The injection corpus is a corpus of values**,
because a value that reached the SQL as text would be a client who can read the
database. **The fuzz corpus is seeded**, so a failure is reproducible, and every
failure has to be one of the errors the application knows how to answer.

**The corpus holds every command that changes data.** Not the two that are
famous — the whole family, because a filter that blocks `DROP TABLE` and lets
`UPDATE users SET role = 'super_admin'` through has not blocked anything. The
payload that changes a row is just as short as the one that drops a table, so
the corpus carries insert, update, delete, merge, upsert, copy, create, alter,
drop, truncate, grant, revoke, execute, call, set, vacuum, reindex, lock,
transaction control and the rest — plus the read-only ones, because a statement
that reads somebody else's password is nearly as bad as one that changes a row.

**And the fragment is a predicate, never a statement.** The corpus proves the
payloads somebody thought of; this holds for the ones nobody did. A translated
fragment may contain a column name, a parameter, a comparison and a boolean
operator, and nothing else — a word outside that vocabulary is a statement, and
a semicolon is how a second statement begins. The translator emits a boolean
expression over columns and parameters, so there is no shape an input could
take that would make it a statement.

## Utilities worth knowing

| Utility                       | Note                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `utils/password.util.ts`      | scrypt hashing, plus `generatePassword` for seeds                             |
| `utils/encryption.util.ts`    | AES-256-GCM with the auth tag verified on read                                |
| `utils/recovery-code.util.ts` | Crockford base32, no I/L/O/U, so a code read aloud is not mistyped            |
| `utils/user-agent.util.ts`    | dependency free best effort; swap for `ua-parser-js` if coverage matters more |
| `utils/request-id.util.ts`    | generation, sanitising, and the async context                                 |

Each has a test next to it where the behaviour is worth pinning.
