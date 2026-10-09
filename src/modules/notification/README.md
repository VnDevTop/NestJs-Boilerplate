# Notifications

Operational alerts to Telegram, Slack, Discord, an operator mailbox or the log.
Tells an operator that an account was created, a sign-in was blocked, a new device
appeared, a second factor changed hands, or the nightly cleanup did not finish.

## The shape of it

```text
a business service
  └─ NotificationEventsService.notify('user.registered', {...})
       └─ JOB_QUEUE.enqueue('notification', { name: 'notify.send', payload })
            └─ NotificationProcessor          both drivers call this
                 └─ NotificationService       the only implementation of delivery
                      ├─ PreferencesService    is this user muted on this channel?
                      ├─ per channel: send, retry, log one row
                      └─ NotificationLogService  append to notification_logs
```

Nothing here awaits a webhook. A registration returns its token whether or not redis
is reachable, and the notification is the only thing lost when it is not.

## Two modules, and why

| Module                     | Position            | Holds                                                                       |
| -------------------------- | ------------------- | --------------------------------------------------------------------------- |
| `NotificationModule`       | **below** the queue | config, entities, channels, `NotificationService`, `NotificationLogService` |
| `NotificationEventsModule` | **above** the queue | `NotificationEventsService`, the preferences controller                     |

The queue's router injects `NotificationProcessor`, which injects the delivery
service. So the delivery service cannot be in a module that enqueues — that would
close a cycle. This is the same split Phase 16 made for retention: one direction of
import, and the two halves meet in a module above. `notification.graph.spec.ts`
asserts it, because a cycle does not fail a test, it fails at boot naming a provider
rather than the import that caused it.

`MaintenanceModule` is the exception that proves the rule: it imports
`NotificationModule` (also below the queue) and reports an anomaly **directly**
rather than enqueueing, because the retention processor is already running inside a
job and there is no request to keep off the critical path.

## Channels

A channel is a name, an enabled check and a send:

```ts
export interface NotificationChannel {
  readonly name: NotificationChannelName;
  isEnabled(): boolean;
  send(payload: NotificationPayload): Promise<ChannelResult>;
}
```

That interface is the whole extension story. A third party adds a channel by
providing a class with this shape and adding it to `buildChannels`; no service
changes, and there is no `if (channel === 'telegram')` in the delivery path.

| Channel    | Package | Notes                                                                     |
| ---------- | ------- | ------------------------------------------------------------------------- |
| `console`  | none    | The development default. Writes to the log under the event's own name     |
| `telegram` | none    | Raw HTTPS to the Bot API. `escapeMarkdownV2` applied in the transport     |
| `slack`    | none    | Incoming webhook, Block Kit sections. `mrkdwn` escaped with HTML entities |
| `discord`  | none    | Same webhook shape, but `content` + `embeds` — **not** Slack's payload    |
| `email`    | none    | Delegates to `MailService` and the `notification` mail template           |

Nothing here needs a package. `HttpModule` from `@nestjs/axios` is the only
transport, and the boilerplate already depends on it. See
`docs/optional-integrations.md`.

### Discord is not Slack's payload

The Phase 12 transport noted that one implementation could serve both, and for the
_url_ and the transport that is true. The _body_ is not the same: Discord ignores
`text` and posts an empty message, because its field is `content`, and it calls a
Block Kit section an `embed`. A channel that reused Slack's payload would deliver
nothing while answering 200.

### Telegram topic routing

One bot can reach several rooms in a forum chat. A topic for a whole chat goes in
`TELEGRAM_TOPIC_ID`; per-event topics go in `TELEGRAM_TOPICS` as `event=topicId`
pairs and take precedence:

```dotenv
TELEGRAM_TOPIC_ID=7
TELEGRAM_TOPICS=auth.login.failed=42,auth.2fa.enabled=43
```

An event with no route of its own lands in the default room rather than being
dropped — a notification in the wrong place is recoverable, a missing route is a
notification nobody sees. A malformed pair is dropped rather than failing the boot.

## Escaping, per channel, once

The event registry emits **plain text**. Slack's `mrkdwn`, Telegram's MarkdownV2 and
Discord's markdown have no common subset a sender could target: one escapes with a
backslash, the other with HTML entities. So the sender does not escape at all and
each channel escapes for itself, next to the markup that needs it.

That matters because a notification body carries a user-supplied email address and a
user-supplied device label. Without the Slack escaping, an address containing `<`
becomes `<https://…|label>` — a clickable link in a shared ops channel.

## Preferences

`GET` and `PATCH /notifications/preferences`. Opt-out: **absence means on**. A table
nobody has written to yet must not silence everything, or a fresh install looks
broken and the fix is "seed the table" — the opposite of opt-out-by-default.

```json
{
  "preferences": [
    { "event": "user.registered", "channel": "slack", "enabled": false }
  ]
}
```

- One row per (user, event, channel), so a user who muted Slack has not muted
  Telegram.
- `PATCH` applies only the pairs it names. A client built before an event existed
  would wipe that event's preference on every save if the route replaced the list.
- Reads are cached under `user:<id>:notifications`, one query for all of a user's
  pairs. The write drops that key **once, after every row in the batch**: an eviction
  landing between two writes would let a concurrent read refill from a half-applied
  state and cache that answer for the rest of the TTL.
- No foreign key to `users`. A soft-deleted user is hard-deleted by the retention job
  thirty days later, so a cascade would erase the preference at the moment an
  administrator restored the account.
- A failed lookup answers **on**. A preferences table that is briefly unreachable must
  not silence the deployment's operator alerts.

## Delivery

**Failure-isolated per channel.** A Telegram webhook that times out does not stop the
message reaching Slack, does not stop the log row being written for either, and never
reaches the request that triggered it.

**Retries are per channel, inside the service**, not left to the queue. A queue retry
would re-attempt _every_ channel for the sake of the one that failed, and a Slack
alert would arrive five times because Telegram was down. `NOTIFICATION_RETRIES`
counts _additional_ attempts, so `2` is three tries, with the same exponential backoff
shape `queue/retry.policy.ts` uses.

**A 4xx stops immediately.** A revoked token answers identically every time, so
retrying only delays the dead-letter entry that says the credential is wrong.

**The job succeeds on a partial delivery.** The processor's classification is the
opposite of `MailProcessor`'s: mail is one recipient and one provider, a notification
is several channels, and the question worth asking is whether anybody received it. A
total failure is retryable only while something was worth retrying.

## The log

`notification_logs` gets **one row per channel per notification**, written whether the
delivery worked or not — the row that says Telegram refused with a 401 is the row an
operator needs. The rendered body is stored (capped at 1000 characters) so "what did
it actually say" is answerable from the row rather than from a template history a
deploy has already overwritten.

Every write failure is swallowed. A log insert that threw would turn a delivered
webhook into a failed job, which the queue would retry, which would deliver it again.
An operator would rather have a missing row than a tripled security alert.

Cleaned by the retention job at `RETENTION_NOTIFICATION_LOGS_DAYS` (30 by default),
on the row's own `createdAt`. An old row for a channel that started failing _yesterday_
is the row an operator wants; a predicate on the event's own date would keep exactly
the wrong ones.

## Events

| Event                                    | Raised by                                               | Carries                              |
| ---------------------------------------- | ------------------------------------------------------- | ------------------------------------ |
| `user.registered`                        | `AuthService.register`                                  | address, first name                  |
| `user.deleted`                           | `UsersService.softDelete`                               | address, the actor                   |
| `auth.login.failed`                      | `AuthService.login`, on the attempt that starts a block | address, failure count, block length |
| `auth.device.login`                      | `AuthService.login`, when the device row was created    | address, device, ip, time            |
| `auth.2fa.enabled` / `auth.2fa.disabled` | the two-factor routes                                   | address                              |
| `maintenance.retention.anomaly`          | `RetentionProcessor`                                    | reason, pending, failed, duration    |

Each takes exactly the fields it interpolates. **No signature here mentions a user
entity**: an event that _can_ read `user.password` is one refactor away from posting
a credential to a shared channel, and the type is what stops it.

Two of these are deliberately narrower than they look:

- **`auth.login.failed` fires for addresses that do not exist.** The lockout counts
  failures against unknown addresses — that is the price of not letting a 429 answer
  which addresses exist — so an operator watching for attack traffic needs to see a
  burst against an address not in the database. It is gated on `firstBlock` instead,
  which is the deduplication that matters: one alert per block, not one per request.
- **`auth.device.login` fires only when `DeviceService.register` created the row.**
  Alerting on every sign-in trains an operator to ignore the channel.

## Configuration

```dotenv
NOTIFICATION_ENABLED=false          # master switch, overrides every channel
NOTIFICATION_CONSOLE_ENABLED=true   # the development default
NOTIFICATION_TIMEOUT=5000
NOTIFICATION_RETRIES=2
NOTIFICATION_RETRY_DELAY=1000
NOTIFICATION_THROW_ON_FAILURE=false # for local debugging only; see below

TELEGRAM_ENABLED=false
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_TOPIC_ID=
# TELEGRAM_TOPICS=auth.login.failed=42

SLACK_ENABLED=false
SLACK_WEBHOOK_URL=
SLACK_CHANNEL=

DISCORD_ENABLED=false
DISCORD_WEBHOOK_URL=
DISCORD_CHANNEL=

NOTIFICATION_EMAIL_ENABLED=false
NOTIFICATION_EMAIL_TO=              # comma separated
```

A channel switched on with no credential **logs why and is dropped**. Every other
outcome of that misconfiguration — silence — looks identical to a working integration.
`env.validation.ts` refuses an enabled channel with no credential at boot, but the
runtime check exists because the log is what an operator sees at 3am.

`NOTIFICATION_THROW_ON_FAILURE` turns a soft failure into a throw. It is off by
default and exists so a test can assert a broken channel was _tried_ rather than
skipped. Leaving it on in production is how a broken webhook becomes a failing job.

## Known limits

- **A redelivery of a subject-less event can deliver twice.** The dedupe key carries a
  fresh uuid unless the caller supplies `subjectId`, which is deliberate: a key from
  the event name alone would suppress the second failed sign-in of an ongoing attack.
  The cost is that the at-least-once queue's duplicate is not caught for events with
  no natural subject.
- **`NOTIFICATION_EMAIL_TO` holds operator addresses in `notification_logs`**, as does
  every event's rendered address. That is personal data in a table that outlives the
  process, which is what the retention window bounds.
- **The email channel is queued twice**: once as a notification, then again by the
  mail job its delegation enqueues. Acceptable because the notification job is
  already off the request path; re-implementing transport selection in this module
  would be the alternative genuinely worth avoiding.
- **Preferences are read with the auth TTL** (`CACHE_AUTH_USER_TTL`, 60s), so a mute
  can take up to a minute to apply. One knob rather than two that mean roughly the
  same thing.
- **Nothing reads `notification_logs` through the API.** `NotificationLogService` has
  `recent()` and `forNotification()`; Phase 20's operational work is what puts them
  behind a route and a permission.
