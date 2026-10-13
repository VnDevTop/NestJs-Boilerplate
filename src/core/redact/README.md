# Redaction

One list of field names, used by the logger and the audit trail.

```ts
redactValue({ user: { password: 'hunter2' } }); // by key, any depth
redactText('reset link sent: ?token=abc123'); // inside a sentence
redactForLog(message); // picks the right one
```

## Why the list is by name

There is no reliable way to tell a secret from an ordinary string: a JWT looks like
a hash, a hash looks like a nonce. Naming the fields is the only rule that can be
applied to a payload nobody has seen yet, and every application uses the same
names for the same things.

**Exact match, case-insensitive.** `tokenCount` and `tokenisedAt` are not secrets,
and a list that redacts them makes the output unreadable and trains people to ignore
the redaction — which is worse than the leak it prevents.

## The one place the list is deliberately too long

`code` is redacted, and `code: 'EN'` is an ordinary field. Here `code` is where a
six digit one-time password arrives (`TwoFactorCodeDto.code`), so a missed
redaction there is a second factor in a log shipper. An annoyance is the right
trade; a leak is not.

## Two passes, and neither subsumes the other

| Pass    | Sees                                                 |
| ------- | ---------------------------------------------------- |
| by key  | a structured payload — a request body, an audit diff |
| by text | a credential in a _sentence_, with no key above it   |

Most log lines in this application are strings. `Failed to reset for ${email} using
${token}` compiles to one, and the key-based pass cannot see inside a string.

`Error` is the case that catches people out: once flattened, its `message` and
`stack` are strings, so the key pass sees nothing. `logger.error(new Error('reset
failed for ?token=abc'))` is precisely the line that leaks, and it is the line
written to explain a fault — so `AppLogger` runs `redactText` over both explicitly.

## The text patterns are narrow on purpose

Each one has to match a credential **and** something identifying it as one, so a
false positive is close to zero. `?token=[redacted]` keeps the parameter name,
because a line reading `?link=[redacted]` tells an operator nothing while
`?token=[redacted]` still says it was a reset link rather than a verification one.

Overlapping patterns are the bug to watch for. An earlier version of the `key:
value` pattern matched values an earlier pattern had already replaced, producing
`?token=[redacted]]`. The fix is a `(?!\[redacted\])` lookahead, and the test is
asserted against the doubled bracket — a visible bug is a good bug, because it is
what stops somebody deciding the redaction is broken and turning it off.

## Replaced, not removed

A key that disappears makes "the password changed" indistinguishable from "this
payload never had a password". A visible `[redacted]` answers the question without
answering it wrongly.

## Circular references

`redactValue` returns `[circular]`, and the logger's `JSON.stringify` replacer
does the same. Without this a self-referencing object throws inside the logger and
breaks the request it was describing — which is what makes the guard load-bearing
rather than tidy.

The `WeakSet` is threaded through the array branch as well. A fresh set per array
would make `a.list[0] === a` walk forever, and that is the case this pass most
needs to survive: it is called on request bodies.

## Depth

Twelve levels, then `[too deep]`. A body can nest ten thousand levels deep, and
unbounded recursion inside an error handler is a stack overflow at the worst
possible moment.
