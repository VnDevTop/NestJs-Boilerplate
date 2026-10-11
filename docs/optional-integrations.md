# Optional Integrations

An integration can exist in the code without its package existing on disk. A
feature nobody enabled costs zero dependencies, zero install time and zero
memory: the module resolves to `null` and the app carries on.

## How it works

`src/core/optional/optional.util.ts` exposes `loadOptional<T>(specifier)`, built
on `createRequire(import.meta.url)`:

```ts
const loaded = loadOptional<typeof import('nodemailer')>('nodemailer');
// typeof import(...) is a type only, so it needs no runtime import.
```

A bare `import` of an optional package is resolved when the app is built, so a
missing package becomes a build failure rather than a disabled feature. Nothing
in `src/` may statically import a package from `OPTIONAL_PACKAGES`;
`optional-packages.spec.ts` fails the build if one ever does.

Registrations go through `createOptionalProvider()`, whose `useFactory` returns
the module or `null`:

```ts
providers: [
  createOptionalProvider('nodemailer', { isEnabled: () => config.enabled }),
];
```

`null` is a supported injected value. Consumers branch on it and fall back; they
never throw, because a feature nobody enabled must not be a startup failure.

## Enabling a feature

1. Install the package.
2. Set the env flag.
3. Restart. No code change.

| Feature                | Package to install (only if enabled) | Env flag                  | Install command                     |
| ---------------------- | ------------------------------------ | ------------------------- | ----------------------------------- |
| SMTP (production mail) | `nodemailer`                         | `MAIL_TRANSPORT=smtp`     | `npm install nodemailer`            |
| Amazon SES             | `@aws-sdk/client-sesv2`              | `MAIL_TRANSPORT=ses`      | `npm install @aws-sdk/client-sesv2` |
| SendGrid               | `@sendgrid/mail`                     | `MAIL_TRANSPORT=sendgrid` | `npm install @sendgrid/mail`        |
| BullMQ queue           | `@nestjs/bullmq` + `bullmq`          | `QUEUE_ENABLED=true`      | `npm install @nestjs/bullmq bullmq` |

## Package-free integrations

These ship in the box, because the implementation is small enough that a
dependency would cost more than the code:

| Feature                 | Env flag                          | Install command   | Implementation                                                     |
| ----------------------- | --------------------------------- | ----------------- | ------------------------------------------------------------------ |
| Development mail        | `MAIL_TRANSPORT=memory`           | nothing, built in | `transports/memory-mail.transport.ts` keeps messages in memory     |
| Telegram notifications  | `TELEGRAM_ENABLED=true`           | nothing, built in | `transports/telegram.channel.ts`, MarkdownV2 escaped centrally     |
| Slack notifications     | `SLACK_ENABLED=true`              | nothing, built in | `transports/slack.channel.ts`, incoming webhook, Block Kit payload |
| Discord notifications   | `DISCORD_ENABLED=true`            | nothing, built in | `discord.channel.ts` in the notification module                    |
| Operator alerts by mail | `NOTIFICATION_EMAIL_ENABLED=true` | nothing, built in | delegates to `MailService`, so it inherits its transport selection |

None of these five adds a package of its own. Discord has its own class rather
than sharing Slack's, because the _url_ and the transport are the same shape but
the _body_ is not: Discord ignores Slack's `text` field and posts an empty
message, since its field is `content` and it calls a section an `embed`.

`discord` is registered in `PACKAGE_FREE_INTEGRATIONS` alongside the other two, so
`optional-packages.spec.ts` keeps the list honest. They post through
`transports/json-poster.ts`, a thin wrapper on `HttpService` from `@nestjs/axios`,
which the boilerplate already depends on, so a channel is payload building and
nothing more:

```ts
import { HttpModule } from '@nestjs/axios';

@Module({ imports: [HttpModule] })
export class NotificationModule {}
```

`postJson()` returns the status instead of throwing on a 4xx, because a rejected
message is a fact to log, while a network failure still rejects so the caller can
retry. It refuses anything but `https:`, so a bot token is never sent in clear
text.

## Where each piece lives

```text
src/core/optional/
├── optional.util.ts        loadOptional, the only way to reach an optional package
├── optional.provider.ts    createOptionalProvider, the useFactory that may return null
├── optional-packages.ts    the package list, the env flags and the install commands
└── transports/             the in-house, package-free implementations
```

See `src/core/optional/README.md` for the rules that apply when adding one.
