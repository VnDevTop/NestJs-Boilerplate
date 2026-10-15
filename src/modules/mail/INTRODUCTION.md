# Mail — Introduction

Transactional mail, rendered from templates and delivered off the request path,
with one record per delivery attempt.

The detailed reference is [README.md](README.md).

## Nine templates

Every template takes a hand-written data interface with exactly the fields it
renders. No signature mentions a `User` or an ORM row, so `user.password` is not
reachable from a template — the type system enforces it, not review.

| Template                     | Carries                                    |
| ---------------------------- | ------------------------------------------ |
| `welcome`                    | first name                                 |
| `verify-email`               | one-time link, expiry                      |
| `reset-password`             | one-time link, source IP, expiry           |
| `password-changed`           | IP, device label                           |
| `new-device-login`           | device label, IP, time                     |
| `account-locked`             | reason, support URL                        |
| `account-permanently-locked` | reason, unlock link, expiry, failure count |
| `account-unlocked`           | who unlocked, support URL                  |
| `notification`               | operator alert headline and body           |

Three carry a **live one-time token** in a URL — verification, reset and
account unlock. That is the design: a token has to reach the inbox to be useful.
No template contains a password, a 2FA secret, a recovery code or a session id,
and the sample data used by preview is deliberately fake (`203.0.113.7`,
`sample-token`) because preview output is rendered to whoever is logged in.

## Transports

| `MAIL_TRANSPORT` | Provider                    | Package                                           |
| ---------------- | --------------------------- | ------------------------------------------------- |
| `memory`         | logs only, delivers nothing | none — **default**, and **refused in production** |
| `smtp`           | nodemailer                  | optional, not a dependency                        |
| `ses`            | `@aws-sdk/client-sesv2`     | optional, not a dependency                        |
| `sendgrid`       | `@sendgrid/mail`            | optional, not a dependency                        |

Every provider package is optional and absent from a fresh clone. A configured
but uninstalled provider **falls back to memory** and logs at `error`, so a
deployment with none installed boots and tells you which transport actually ran
rather than reporting success for mail it dropped.

## Delivery

Queued, never inline. The job payload carries `{to, template, data}` — not a
rendered message — so a template edited between enqueue and run is honoured.

| Property           | Value                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| Attempts           | 5 (`QUEUE_RETRY_ATTEMPTS`)                                                                        |
| Backoff            | 1 s → 2 s → 4 s → 8 s, capped at 60 s                                                             |
| Retried on         | timeouts and 5xx                                                                                  |
| **Not** retried on | provider 4xx — `retryable: false`, no budget spent                                                |
| Deduplicated       | SHA-256 of `{template, to, subjectId}`, released on a retryable failure so the retry can re-claim |
| Dead-letter        | `dead-letter:jobs` in Redis, trimmed to 500                                                       |

A provider failure never becomes a request failure: `deliver()` returns
`delivered: false` and the request proceeds.

## `mail_logs`

One row **per attempt**, not per send: mail id, template, recipient, transport,
subject, delivered, status code, attempts, permanent, error, `requestId`.

No foreign key to `users` — deliberately, so the evidence that a message was
attempted outlives the account. Retention is 30 days by default, framed as a
data-retention decision because the recipient column is personal data.

## Template safety

A database-stored template is operator-authored, so it is treated as untrusted
input:

- A **private** Handlebars instance, so no helper registered elsewhere leaks in.
- **Four helpers total**: `isNull`, `actionLink`, `bodyLines`, `bodyLinesText`.
- `knownHelpersOnly`, `strict`, `noEscape: false`.
- `{{{ }}}` is rejected outright — stored templates cannot emit unescaped output.
- Unknown helpers are refused **before the write**, because Handlebars only
  detects them at render time.
- The HTML shell — doctype, `<title>`, the "replies are not read" footer — is
  applied **after** rendering, so an operator editing a body cannot remove it.

What a stored template can do: interpolate its own fields, call four helpers,
emit static markup, loop and branch. What it cannot do: execute anything, reach
the environment, reach a field it was not given, or change the envelope.

## Standards alignment

Not a compliance claim — see [../auth/INTRODUCTION.md](../auth/INTRODUCTION.md).
Mail is where a lot of personal data leaves the system, which makes it relevant
to privacy rules even though it is not a named HIPAA safeguard.

| Requirement                                                  | Status      | Notes                                                                                                                                              |
| ------------------------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| GDPR Art. 5(1)(f) — integrity and confidentiality in transit | **partial** | SMTP/SES/SendGrid over TLS; SMTP **STARTTLS is not forced** in code and depends on the provider                                                    |
| GDPR Art. 5(1)(e) — storage limitation                       | **met**     | `RETENTION_MAIL_LOGS_DAYS`, default 30                                                                                                             |
| GDPR Art. 4(7) — erasure                                     | **partial** | no FK to `users`, so a row survives erasure until retention prunes it — a defensible choice for evidence, but it means the address is still stored |
| HIPAA §164.312(e) Transmission security                      | **partial** | code cannot guarantee TLS to the provider                                                                                                          |
| ISO 27001 A.8.23 Email security                              | **partial** | templates cannot inject script; phishing language is still operator-controlled                                                                     |

The gap worth naming: **an operator holding `mail-template:write` controls the
wording of your security emails** — "your password was changed", "your account
was locked". That is inherent to the feature and is why the permission is
gated, audited, and why editing is versioned rather than free-form.

## Known gaps

| #   | Gap                                                                                                                                                   | Where                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1   | **`mail_logs.error` is not redacted** — a provider error body can contain a token, an SMTP auth string or an address, stored verbatim up to 500 chars | `mail-log.service.ts`                |
| 2   | A configured-but-uninstalled provider degrades to memory silently — logged at `error`, but delivery becomes a no-op                                   | `mail.service.ts`                    |
| 3   | SES and SendGrid accept **no timeout configuration**                                                                                                  | transports                           |
| 4   | `updatedBy` is always null, so template version history has no editor                                                                                 | `admin/mail-templates.controller.ts` |
| 5   | SMTP `STARTTLS` is not required in code                                                                                                               | `smtp.transport.ts`                  |
| 6   | There is no DKIM/SPF guidance anywhere in the repo — deliverability and spoofing resistance are entirely the operator's problem                       | —                                    |
| 7   | The mail path awaits the enqueue and propagates a queue rejection, unlike the notification path which swallows it                                     | `mail.service.ts`                    |

## Where to go next

- [README.md](README.md) — transports, templates and failure handling.
- [../queue/INTRODUCTION.md](../queue/INTRODUCTION.md) — retry and dedup.
- [../audit/INTRODUCTION.md](../audit/INTRODUCTION.md) — who may edit a template.
