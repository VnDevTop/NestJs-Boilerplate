# Configs Layer

Every environment value the application reads, in one place, as namespaced and
typed objects.

```text
configs
├── app.config.ts            app name, port, route prefix, version, public url
├── cache.config.ts          Redis/Valkey/memory cache
├── cors.config.ts           browser origins
├── database.config.ts       TypeORM connection
├── jwt.config.ts            access and refresh token settings
├── observe.config.ts        observability provider
├── redis.config.ts          redis for the queue and the shared throttler
├── security.config.ts       helmet headers
├── swagger.config.ts        API docs
├── throttler.config.ts      rate limiting
├── two-factor.config.ts     2FA switch, encryption key, issuer
├── mail.config.ts           transport, sender, provider credentials, timeouts
├── notification.config.ts   per-channel switches and credentials
├── queue.config.ts          queue behaviour, retry, concurrency, fallback
├── retention.config.ts      every retention age, batch size, schedule
├── password-policy.config.ts  length, character classes, history, lockout
├── env.validation.ts        startup validation of the whole environment
└── index.ts                 re-exports everything
```

## Two kinds of namespace

The ones in `index.ts` and the `load` array of `app.module.ts` configure the app
itself. The rest are deliberately **not** exported and **not** loaded globally.

| Namespace                                                      | Why it is separate                                                                                                                                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mail`, `notification`, `queue`, `retention`, `passwordPolicy` | They describe optional integrations. Loaded with `ConfigModule.forFeature()` inside the module that needs them, so the app carries none of it and that module imports with no provider package installed. |

A `forFeature` namespace is read through `ConfigService` the same way, by key.
The difference is who registers it, not how it is consumed.

```ts
// in MailModule
@Module({ imports: [ConfigModule.forFeature(mailConfig)] })
export class MailModule {}
```

## Rules

- No `process.env` outside this folder. The one exception is a CLI that runs
  outside Nest, such as `src/database/data-source.ts`.
- One namespace per domain, registered with `registerAs`, and read through
  `ConfigService` by key.
- A config returns the **options object the library wants**, not a second shape
  that has to be translated. `cache.config.ts` returns `ThrottlerModuleOptions`
  and `cors.config.ts` returns Nest's `CorsOptions`, so both are passed straight
  to the library that consumes them.
- An optional provider's option shape is **declared locally**, not imported from
  the provider. A type-only `typeof import('nodemailer')` is still resolved by
  `tsc`, so a clone without the package would fail to typecheck. Each shape
  mirrors the option object its client expects and is passed straight through.
- Values that are not present take their default here, and the default is
  documented in `.env.example`.
- A variable that is off by default should not point anywhere by default. An
  empty `url` fails loudly; a guessed `localhost` fails silently in production.

## How a value reaches a service

```ts
// the config
export const securityConfig = registerAs('security', (): SecurityConfig => ({
  enabled: process.env.SECURITY_ENABLED !== 'false',
  hsts: { maxAge: Number(process.env.SECURITY_HSTS_MAX_AGE ?? 31536000) },
}));

// the consumer
const security = this.configService.getOrThrow<SecurityConfig>('security');
```

`getOrThrow` rather than `get` with a fallback, so a missing namespace fails
loudly instead of silently using a default that was never meant to apply.

## Environment validation

`env.validation.ts` is wired into `ConfigModule.forRoot({ validate })`, so it
runs before anything connects and reports **every** problem at once rather than
one per restart.

```text
Invalid environment configuration:
  - DATABASE_URL must use one of: postgres:, postgresql:
  - JWT_SECRET must be at least 32 characters
  - JWT_REFRESH_SECRET still holds the example value
```

Strictness depends on `NODE_ENV`. Development only checks presence, so a
placeholder does not block local work. Production requires long secrets and
rejects any that still hold a value from `.env.example`, because that file is in
the repository and a secret in it is not a secret.

The schema describes the rules; zod's own messages are kept, since a schema that
says what is wrong is enough. Messages are written only for the handful of
`refine` checks where zod would otherwise say nothing useful.

Rules that are conditional rather than per-variable, because they are about a
combination being meaningful, or because a default is dangerous in production:

| Rule                                                                   | Why                                                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `OBSERVE_*` all set or all unset                                       | A partial set silently disables observability                                                                            |
| `CORS_CREDENTIALS` needs a real allow-list                             | Browsers reject credentials with a wildcard, so it would only look like it works                                         |
| `TWO_FACTOR_ENCRYPTION_KEY` required while 2FA is on                   | The config defaults to a published key, so a deploy that forgets it would encrypt secrets with a value in the repository |
| `CACHE_URL` required for a shared backend                              | Otherwise it silently aims at localhost                                                                                  |
| `MAIL_TRANSPORT` not `memory` in production                            | The memory transport is a no-op that reports success, so every dashboard says mail is sent while nothing is delivered    |
| `MAIL_FROM` required in production                                     | A wrong value sends a password reset token to another deployment                                                         |
| `APP_URL` required and `https` in production                           | Every email link is built from it                                                                                        |
| `TELEGRAM_*`, `SLACK_*`, `DISCORD_*` credential when the channel is on | An enabled channel with no credential drops every message, which looks identical to a working one                        |
| `NOTIFICATION_EMAIL_TO` when the email channel is on                   | Same, for the one channel that is a delegation rather than a webhook                                                     |
| `QUEUE_REDIS_URL` required when the queue is on                        | Without it the queue silently becomes the in-process fallback, which is a slower deployment rather than the intended one |
| `REDIS_KEY_PREFIX` must differ from `CACHE_KEY_PREFIX`                 | The cache evicts by TTL, so a shared prefix discards pending jobs                                                        |
| `RETENTION_*_DAYS` at least 1                                          | A zero means "delete everything older than now": a typo becomes data loss                                                |

Every one of these fires at boot, through `superRefine`, rather than inside a
service. A rule checked at the point of use is a rule that fires at the first
email instead of at deploy.

**Blank means unset.** A variable set to an empty string is dropped before
validation, because `.env.example` documents every optional as `KEY=` so the file
can be copied and edited. A required variable set to blank is still reported as
missing, so dropping the blank does not make it optional.

`validateEnvironment` returns the original config object, not zod's parsed copy.
Each config file does its own `Number()` conversion, so returning coerced values
would change types that `ConfigService` callers already handle.

## Adding a config

For an app-level setting:

1. Add `x.config.ts` with `registerAs('x', ...)`.
2. Export it from `index.ts`.
3. Add it to the `load` array in `src/app.module.ts`.
4. Add the variable to `types/env.d.ts` and `.env.example`.
5. Add a rule for it in `env.validation.ts` if a wrong value is possible.

For an optional integration, steps 2 and 3 are replaced by:

2. Leave it out of `index.ts` and out of the `load` array.
3. Register it with `ConfigModule.forFeature(xConfig)` in the module that needs
   it, and add a comment at the top of the file saying why.
4. Add the variables to `types/env.d.ts` and `.env.example`, including the
   install command for the package in `docs/optional-integrations.md`.
