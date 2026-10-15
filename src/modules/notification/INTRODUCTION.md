# Notification — Introduction

Operational alerts to Telegram, Slack, Discord, an operator mailbox or the log —
over raw HTTPS, with no package for any of them — plus per-user opt-out and a row
per delivery attempt.

The detailed reference is [README.md](README.md).

## Channels

| Channel    | Delivery                               | Credential                                         |
| ---------- | -------------------------------------- | -------------------------------------------------- |
| `console`  | the application log                    | none                                               |
| `telegram` | Bot API `sendMessage`                  | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`          |
| `slack`    | incoming webhook, Block Kit            | `SLACK_WEBHOOK_URL` — **the secret is in the URL** |
| `discord`  | webhook, `{content, embeds}`           | `DISCORD_WEBHOOK_URL` — secret in the URL          |
| `email`    | delegates to [mail](../mail/README.md) | `NOTIFICATION_EMAIL_TO`                            |

Order is webhooks → email → console **last**, deliberately, so the log is the
last word if every channel refuses.

Every credential comes from the environment. **No channel URL is ever read from
a request, a database or a user-supplied value.** `postJson` rejects any
non-`https:` protocol before sending — the Slack and Discord URLs carry the bot
credential, so a misconfigured `http://` webhook fails loudly rather than
sending a secret in clear text. Boot validation refuses to start with a channel
enabled and its credential missing.

A channel whose flag is on but whose credential is absent reports `isEnabled():
false` **and logs why**, because an enabled channel with no URL drops every
message while looking exactly like a working integration.

## Nine events

`user.registered`, `user.deleted`, `auth.login.failed`, `auth.device.login`,
`auth.2fa.enabled`, `auth.2fa.disabled`, `auth.account.locked`,
`auth.account.unlocked`, `maintenance.retention.anomaly`.

Each takes exactly the fields it interpolates — no `User`, no ORM row — so no
signature can reach a credential. `isNotificationEventKey` uses `Object.hasOwn`
rather than `in`, so a `__proto__` payload is rejected.

## Opt-out

Model is **opt-out: absence means ON**, so a user is never silently protected by
a row that never got written. Preferences are unique per `(user, event,
channel)`, and `enabled` is stored explicitly so "off" and "never set" stay
distinguishable.

Enforced per channel at delivery. **A failed preference lookup answers "not
muted"**, twice and deliberately — a briefly unreachable table must not silence
an operator alert about a locked account. The cost is that a muted user may
receive one extra notification.

Preferences are **self-scoped only**. There is no admin route to mute another
user's alerts, because such a route would be a way to stop somebody being told
their account had just been used.

## Delivery

| Property  | Value                                         |
| --------- | --------------------------------------------- |
| Timeout   | `NOTIFICATION_TIMEOUT`, 5 000 ms              |
| Attempts  | `NOTIFICATION_RETRIES` + 1 = 3                |
| Backoff   | `NOTIFICATION_RETRY_DELAY` 1 000 ms, doubling |
| Permanent | HTTP 4xx — not retried                        |

Retries are **per channel inside the service**, not at the queue level, because a
queue retry would re-attempt every channel for one failure.

**A failing webhook never fails the request that triggered it**, at any layer:
`notify()` catches everything, delivery converts a throw into a result, and the
processor classifies a job as failed only when _every_ attempted channel failed.
Partial delivery is explicitly not failure. `NOTIFICATION_THROW_ON_FAILURE`
exists for tests and defaults to false.

## `notification_logs`

**Every channel gets a row, including refused and muted ones** — the muted case
records `error: 'muted by the recipient'` with `attempts: 0`. A skipped alert is
therefore visible rather than invisible. Columns: event, channel, user, recipient,
delivered, status, attempts, `requestId` (indexed), error, body.

Retention: 30 days.

## Security controls

- HTTPS enforced at the transport, not merely recommended.
- Boot-time cross-field validation refuses an enabled channel with no credential.
- One master switch (`NOTIFICATION_ENABLED=false`) silences everything — a single
  lever for an incident.
- Per-channel escaping: Slack HTML entities, Telegram MarkdownV2, so a
  user-supplied email containing `<` cannot become a clickable link in a shared
  operations channel.
- No local state in the delivery service, so there is nothing to forget between
  requests.
- `requestId` rides the job payload and is indexed, so an alert traces to the
  request that raised it.

## Standards alignment

Not a compliance claim — see [../auth/INTRODUCTION.md](../auth/INTRODUCTION.md).

| Requirement                                                     | Status      | Notes                                                                                           |
| --------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------- |
| HIPAA §164.308(a)(5)(ii)(A) Security awareness — log monitoring | **partial** | alerts exist for lockout, new device, 2FA changes; nothing alerts on a credential leak via logs |
| HIPAA §164.312(b) Audit controls                                | **partial** | the delivery log records the channel outcome, not who changed a setting                         |
| GDPR Art. 5(1)(e) Storage limitation                            | **met**     | 30-day default                                                                                  |
| GDPR Art. 4(7) — the body is personal data                      | **partial** | `body` stores rendered emails, device labels and IPs, unredacted                                |
| ISO 27001 A.8.15 Logging                                        | **met**     | every attempt recorded, including refusals                                                      |

## Known gaps

| #   | Gap                                                                                                                                                                                                     | Where                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1   | **Webhook credentials can reach `notification_logs.error`** — `postJson`'s parse failure interpolates the full URL, secret included, into an error message that is stored                               | `core/optional/transports/json-poster.ts:41` |
| 2   | `notification_logs.body` and `.error` are **not redacted** — they hold emails, device labels, IPs                                                                                                       | `notification-log.service.ts`                |
| 3   | **A user can mute security events about their own account**, including `auth.account.locked`, because every per-user event honours the opt-out. There is no "security events are non-mutable" carve-out | `notification-preferences.service.ts`        |
| 4   | Nothing reads `notification_logs` through the API — `recent()` and `forNotification()` exist with no route behind them                                                                                  | `notification-log.service.ts`                |
| 5   | A failed preference lookup delivers anyway — by design, but a mute is not guaranteed under a partial outage                                                                                             | `notification.service.ts`                    |
| 6   | Preferences cache at the auth TTL (~60 s), so a mute is not immediate                                                                                                                                   | `notification-preferences.service.ts`        |
| 7   | A redelivery of a subject-less event can deliver twice — the dedupe key carries a fresh uuid unless the caller passes `subjectId`                                                                       | `notification-events.service.ts`             |
| 8   | The email channel is enqueued twice, once directly and once by the mail job it delegates to                                                                                                             | `email.channel.ts`                           |
| 9   | `NOTIFICATION_THROW_ON_FAILURE` left `true` in production turns a broken webhook into a failing job, and nothing warns                                                                                  | `notification.config.ts`                     |
| 10  | A malformed Telegram topic pair is silently dropped                                                                                                                                                     | `notification.config.ts`                     |

Gap 3 deserves a decision rather than a fix. An opt-out that a subject can
exercise over the alerts telling them their account was attacked is arguably
backwards — but it is also their channel, and the design documents the choice
rather than hiding it.

## Where to go next

- [README.md](README.md) — events, channels and failure behaviour.
- [../mail/INTRODUCTION.md](../mail/INTRODUCTION.md) — the email channel.
- [../queue/INTRODUCTION.md](../queue/INTRODUCTION.md) — how the job is delivered.
