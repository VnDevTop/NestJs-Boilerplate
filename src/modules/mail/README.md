# Mail

Rendering, transport selection, delivery, and the record of what was delivered.

## The delivery record

`mail_logs` holds one row per **attempt**. It is the answer to "the user says they
got nothing" — every other place that knows about a send is gone or unreachable by
the time that question arrives as an address and a rough time.

One row per attempt rather than per send because a send is retried and each attempt
is a separate answer from a separate provider response. The sequence is what
separates "the network is flaky" from "the credential expired four attempts ago".

| Column      | Why                                                        |
| ----------- | ---------------------------------------------------------- |
| `mailId`    | correlates the row with the log line and the provider call |
| `to`        | who it was for — personal data, hence the retention window |
| `transport` | so a failure can be attributed to a provider               |
| `permanent` | why the retry budget was not spent on it                   |
| `requestId` | **the request that caused this send**                      |

### The request id is why the column is indexed

"A user asked for a reset at 14:02 and nothing arrived" becomes one indexed read:

```ts
await this.mailLog.forRequest('e3b0c442-…');
```

rather than a recipient search across a guessed time window.

**It travels in the job payload**, not read at send time. The send happens in the
worker — possibly much later, if the queue is backed up — and by then the async
context that held it is gone. Reading it at delivery time would write `null` on
every row, silently, which is the worst possible shape for a correlation column: it
looks implemented.

Null rather than omitted when there is genuinely no request — a retention job's own
mail, a scheduled digest.

### A failed write never fails the send

An insert that threw would turn a delivered email into a failed job, which the queue
would retry, which would send it again. A duplicate verification email is a worse
outcome than a missing log row.

## Retention

`RETENTION_MAIL_LOGS_DAYS`, 30 by default. The largest of the retention tables — one
row per attempt, four or five per registration on a busy deployment — and the one
holding the most personal data, so the window is a data-retention decision rather
than housekeeping.
