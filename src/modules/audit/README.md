# Audit

Who did what, to which row, from where, in which request.

## The one thing this module exists to get right

**A password never reaches an audit row.**

An audit diff is built from whatever object the action was performed on, and that
object is usually a `User` entity — which carries `password`, an scrypt hash. A
table of "who changed what" that quietly also holds every credential the system
has ever had is worse than no audit trail at all: it is a year-long credential
store that is read by operators, exported to a SIEM, and kept in a database
typically less protected than the one it duplicates. And it fails open — nothing
about the table looks wrong until somebody exports it.

So `AuditService` walks every `before` and `after` on the way in and replaces the
value of any key in `REDACTED_KEYS` with `[redacted]`, at any nesting depth.

The key **stays**. "The password changed" is useful to an operator; "this field
exists" is not a disclosure. The same list covers the other bearer credentials
that live on objects an action might touch — reset tokens, the two-factor secret,
recovery codes, a refresh token inside a session object.

Depth is capped at twelve. A request body is a diff source for some actions, and a
body can nest ten thousand levels deep; unbounded recursion there is a stack
overflow inside the error handler.

## When the write fails

**`record()` never throws.** This is the opposite of the usual advice, so here is
the reasoning: an audit write that failed the action it was recording means an
outage in the log turns into an outage in the product. A full audit table or an
unreachable database would turn every privileged action into a 500.

The availability failure is larger, more frequent and more visible than the
integrity failure, and a gap logged at `error` is something an operator can see
happened. A gap that silently failed is not.

The trade is real and is the reason to read the logs: this trail can have holes.
It is the trail that is available during the incident rather than the one that
proves what happened six months later.

## No foreign keys, deliberately

Neither `actorId` nor `targetId` has one, and both are reasons rather than
oversights:

- **The target of an audit entry is frequently the thing being erased.** Phase 19
  adds a right-to-erasure flow; a foreign key would either block that erasure or
  cascade the evidence away with it. An audit trail that deletes its own records
  when the subject is deleted is not a trail.
- **The actor is eventually hard-deleted by the retention job**, on the same
  reasoning.

`actorEmail` is stored _as well as_ the id, because a join would answer with the
address the person has now rather than the one they had when they did it. Both
outlive everything they point at.

## Indexes

Four, one per question an audit table is actually asked:

| Question              | Index                    |
| --------------------- | ------------------------ |
| what happened at T    | `createdAt`              |
| who did this          | `actorId`                |
| show me every X       | `action`                 |
| what happened to _it_ | `(targetType, targetId)` |

The composite on the target is the one that earns its keep — "everything that ever
happened to this user" is what a support conversation asks, and without the
composite it is a full scan of a year of rows.

There is deliberately **no index on `changedFields`**. A jsonb containment index
would serve a query nobody writes, at the cost of a write on every privileged
action.

## The address on the entry

`request.ip` first, because Nest resolves it against the trust proxy setting and
that resolution is the point: behind a load balancer it is the balancer unless
`trust proxy` is set, in which case it is the client.

**Not the `x-forwarded-for` header directly.** That header is client-controlled and
unbounded, and reading it without the proxy trust setting behind it would put an
attacker's chosen string into the `ipAddress` of every row they created.

A repeated `user-agent` header arrives as an array; the first value is recorded
rather than the joined one, so a caller cannot choose a separator and get their own
string into the row.

## Retention

`RETENTION_AUDIT_LOGS_DAYS`, default **365**. Every other target defaults to a
week; this one is the exception the plan's own config comment calls out. An audit
trail kept for a month is not an audit trail, and this is the largest table the
nightly job will ever hold.

Size for it before raising anything else.

## Failures are recorded too

`outcome` is `success` or `failure`, and the failure rows are the half most
systems skip. A permission that was _refused_ is evidence. A permission that was
never asked for is not.

## Which routes are recorded

**Opt-in, through `@Audited()`.** A global interceptor that audited every request
would fill the table with profile reads and sign-ins until nobody read it, and the
entries that matter are the ones that scroll off the top.

```ts
@Audited({
  action: 'users.delete',
  targetType: 'user',
  targetIdFrom: [['param', 'id']],
  diffResponse: false,   // a 204 has nothing to diff
})
@Roles(Role.Admin, Role.SuperAdmin)
@Permissions(Permission.UserDelete)
@Delete(':id')
remove(@Param('id') id: string) { … }
```

`targetIdFrom` is a **list**, because the three shapes are genuinely different
routes: a delete takes its id from the path, a self-service route has no id in the
path at all (`'user'`), and a create only learns the id from what it created
(`'result'`). A source that yields nothing falls through to the next, and a route
that yields nothing at all records a null target rather than failing — incomplete
audit metadata is not worth a 500.

`audit-policy.spec.ts` reads the decorators off the real handlers and asserts every
privileged route carries one, naming its action. A route moved or renamed fails
there instead of quietly going unaudited.

### `before` is always null on an interceptor entry

The interceptor sees the request and the response, never the row as it was. **A
reconstructed before-state in a table presented as evidence is worse than none** —
it looks like a record and it is an inference. Routes whose before-state is worth
having are the ones where the service read the row and knows; those call
`AuditService.record` directly with both sides.

### Failures are recorded too

`catchError` writes an entry for a refused request and rethrows the original error
unchanged. A permission that was refused is evidence; a permission that was never
asked for is not. `recordFailures: false` opts a route out.

The status comes from the exception's own `getStatus`, and is **null** rather than
guessed at 500 when there isn't one. An error that never reached the client has no
status, and a wrong one in an audit table is a small lie that is expensive to notice
later.

### Never awaited

The write goes to the database the request already used, and `record` never throws,
so there is nothing to wait for and something to lose: the response time of every
privileged action.

## Why there is no TypeORM subscriber

The plan asks for one, "for writes that bypass a controller". Two things rule it
out, both checked against the installed TypeORM rather than assumed — the same
finding Phase 17b reached for the cache invalidation subscriber:

- **A subscriber gets no dependency injection.** `ConnectionMetadataBuilder`
  instantiates them with `new metadata.target()`. `AuditService` needs a repository,
  so it would be unreachable except through a module-level singleton — which is the
  drift the module system exists to prevent.
- **It could not identify the row anyway.** `UpdateQueryBuilder` passes `valuesSet`
  as the event entity, so `repository.update()` delivers `{ role: 'admin' }` with no
  id, and `DeleteQueryBuilder` passes no entity at all. Every write that matters
  here is a query-builder write. The subscriber would fire on all of them and be
  able to act on none.

A service that performs a privileged write **without a controller calls
`AuditService.record` directly.** That is the honest version of "writes that bypass
a controller": an explicit call at the write site, rather than a hook that fires on
writes it cannot describe.

## Not in this phase

The admin query surface — a route to read the trail — is not here yet. The entity,
the writer, the interceptor and the coverage spec are.
