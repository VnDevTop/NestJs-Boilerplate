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
├── pagination    cursor encoding, the sort allow-list, the keyset page reader
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
entity, and it holds four decisions.

| File                             | Decision                                                            |
| -------------------------------- | ------------------------------------------------------------------- |
| `cursor.ts`                      | the boundary is opaque base64url, versioned, and a bad one is a 400 |
| `sort.ts`                        | sorting is an allow-list map; the request never reaches a column    |
| `cursor-pagination-query.dto.ts` | `limit`, `cursor`, `sort`, `order` — and no `page`                  |
| `cursor-pagination.ts`           | keyset paging, one row past the limit, both values bound            |

**Keyset, not offset.** `LIMIT n OFFSET m` makes the database count and discard
`m` rows per page, so page 900 reads nine hundred rows to return twenty — and
because that count happens inside the statement, a row inserted between two
requests can appear on both pages or on neither. A cursor names the boundary it
stopped at, so an insert ahead of the reader cannot move it. This is asserted as a
test in `cursor-pagination.spec.ts`, not only described here.

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

### Adding a listing route

1. Declare the sortable columns as a map from request name to column:

   ```ts
   export const ORDER_SORT_FIELDS = {
     createdAt: 'createdAt',
     reference: 'reference',
   } as const satisfies SortFieldMap<'createdAt' | 'reference'>;
   ```

   Every one of them must be `NOT NULL` — a cursor carries its boundary as a
   string, and `null` would have to be encoded as something the decoder reads as
   malformed. That restriction is the reason `nullable` columns are absent from
   these maps, and it is why adding one is a deliberate change rather than a line.

2. Extend `CursorPaginationQueryDto` with the filters, as declared properties.
   A DTO that accepted a `{ [column]: value }` bag and passed it to TypeORM would
   let a caller read any column the entity has, `password` included.

3. `resolveSort(query.sort, query.order, FIELDS, 'createdAt')`, then hand the
   query builder to `paginateByCursor`, and return `PaginatedResultDto.of(items,
meta)`.

4. Add an index that leads with the sort column and carries the id immediately
   after it — `(createdAt, id)`. Ascending only; Postgres scans an index backwards
   for the other direction.

The only thing this buys that matters is the last one: **Phase 24 is a no-op for
every route that follows this one.** Adding a list route after this phase needs no
new pagination code.

## Utilities worth knowing

| Utility                       | Note                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `utils/password.util.ts`      | scrypt hashing, plus `generatePassword` for seeds                             |
| `utils/encryption.util.ts`    | AES-256-GCM with the auth tag verified on read                                |
| `utils/recovery-code.util.ts` | Crockford base32, no I/L/O/U, so a code read aloud is not mistyped            |
| `utils/user-agent.util.ts`    | dependency free best effort; swap for `ua-parser-js` if coverage matters more |
| `utils/request-id.util.ts`    | generation, sanitising, and the async context                                 |

Each has a test next to it where the behaviour is worth pinning.
