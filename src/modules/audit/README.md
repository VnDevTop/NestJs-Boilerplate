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

## Not in this phase

The entity and the writer only. The interceptor that decides what counts as a
privileged action, the TypeORM subscriber that catches writes bypassing a
controller, and the admin query surface are later phases in this one.
