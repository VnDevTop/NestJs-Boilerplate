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

## Tests

`npm test` covers every transport, the registry and all nine templates
(`templates/mail.templates.spec.ts`, which renders each one with hostile data and
asserts nothing user-controlled reaches the html part unescaped).

`npm run test:e2e` boots the whole application with `MAIL_TRANSPORT=ses` and no
`@aws-sdk/client-sesv2` installed, then asserts the send still resolves, names the
transport that actually ran, and leaves a `mail_logs` row an operator can follow.
That suite is the only thing here that would catch a missing `loadOptional`
fallback, because every unit test resolves a transport that is present.

## Configurable templates (Phase 22)

A template is no longer only a file. `email_templates` holds an operator-editable
override per `(name, locale)`, and the `.hbs` file stays the fallback — so an empty
table means the shipped files, and an upgrade that writes nothing behaves exactly as
it did before.

### What is being given up

Phase 14's templates were plain functions. That was right for a boilerplate: they
were code, reviewed in a diff, and the application had no template engine in its
dependency tree. This phase trades both for editability, and the trade is real rather
than rhetorical:

- **`handlebars` is now a runtime dependency.** It is the first one that exists only
  to render mail. Everything else the mail path needs is zero-dependency or optional.
- **Templates are no longer type-checked.** `{{foo}}` in a `.hbs` file is a string,
  not a `WelcomeData`, so a renamed field is a runtime failure rather than a compiler
  error. `template-fields.ts` and the admin route's `fields` list are what stands in
  for the type, which is weaker than the type was.

What is _not_ given up is that a template cannot reach anything it was not given. The
handlebars environment is a private instance with a declared helper list, `strict` is
on, and prototype access is blocked.

### The escaping rule

Handlebars escapes `{{ }}` and does not escape `{{{ }}}`. A stored template that opts
out of escaping turns a first name into script in a mail client, so `save` refuses
one — in every spacing handlebars accepts, since `{{ {x} }}` compiles the same as
`{{{x}}}`.

`.hbs` files in this repository are **not** subject to that rule. They went through
review, which is the property the plain functions had.

A subtlety worth knowing: `Handlebars.escapeExpression` is the _html_ escaper and
encodes `=` as `&#x3D;`. Applied to a url in an `href` that is not cosmetic — it
corrupts the query string, and every verification and reset link in the application
stops working. `escapeAttribute()` in `templates/handlebars.ts` is the narrower
escaper the link helper uses, and `handlebars.spec.ts` pins it.

### Where a template comes from

|                                        |                                                  |
| -------------------------------------- | ------------------------------------------------ |
| A row for `(name, locale)`             | The operator's copy. What the next send renders. |
| Otherwise `templates/hbs/<name>.*.hbs` | What shipped with the image.                     |

The shell — the `<!doctype html>` envelope and the "replies are not read" footer —
stays in `layout.ts` and is applied after rendering. An operator editing a body cannot
remove it.

### Routes

| Route                                | Permission            |                                              |
| ------------------------------------ | --------------------- | -------------------------------------------- |
| `GET /admin/mail-templates`          | `mail-template:read`  | Every template, shipped ones included.       |
| `GET /admin/mail-templates/:name`    | `mail-template:read`  | Source, origin, and the fields it may use.   |
| `POST /admin/mail-templates/preview` | `mail-template:read`  | Renders against sample data. Stores nothing. |
| `PUT /admin/mail-templates/:name`    | `mail-template:write` | Stores it. Keeps the version it replaces.    |
| `DELETE /admin/mail-templates/:name` | `mail-template:write` | Back to the shipped file.                    |

The preview exists because the alternative is learning a broken edit from a support
ticket. It runs the same compiler, the same checks and the same shell as the send, so
a preview that renders is a preview of what will be delivered.

`version` in the PUT body is optimistic concurrency. Two operators editing a password
reset email at once is the normal case in a team, and without it the second save
silently overwrites the first one's wording.

### A broken stored template does not stop a send

If the stored row cannot be rendered, `MailService` logs at `error` and renders the
shipped file instead. The alternative is one operator's mistake becoming a 500 on
every registration in the deployment. The log names the template.

`save` compiles and validates _before_ writing, so a row that would take that path
should never exist — the fallback is for a row written before this validation, or by
a hand-run `UPDATE`.

### Caching and the build

Resolution goes through `CacheService.wrap` under `mail:<name>:<locale>`, so a hot
template expiring under a burst of registrations does not stampede the table. Every
write deletes that key _after_ the transaction commits, for the reason Phase 17b's
auth cache does.

The `.hbs` files are read from disk relative to their own module. `nest build` does
not copy them unless `nest-cli.json` lists them under **`compilerOptions.assets`** —
a top-level `assets` key is read by nothing, and produces a build that succeeds and a
container that fails on the first send. `mail.templates.spec.ts` asserts the entry.

### Seeding and history

`npm run seed` copies the shipped files into `email_templates` with
`ON CONFLICT DO NOTHING`. It never overwrites: a `.hbs` fix in a later release does
not reach a template somebody has edited. A fresh clone has no rows, so it always
gets the files, and `DELETE /admin/mail-templates/:name` is the explicit way back.

Every save writes the version it replaced to `mail_template_versions`, in the same
transaction as the update. Purged by `RETENTION_MAIL_TEMPLATE_VERSIONS_DAYS`.
