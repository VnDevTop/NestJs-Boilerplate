# Installation

Getting this boilerplate running locally, and the two things that bite people
who skip to `npm run start:dev`.

Read this before the README's Quick start if you want to understand _why_ the
steps are in that order. It is short on purpose.

## What you need

|                 | Version     | Why                                        |
| --------------- | ----------- | ------------------------------------------ |
| Node.js         | 22 or newer | `package.json` sets `engines`. CI runs 24. |
| PostgreSQL      | 14 or newer | The schema uses `uuid-ossp`.               |
| Redis or Valkey | 6 or newer  | The cache, the queue and the rate limiter. |
| Docker          | optional    | Only to run the two above in containers.   |

Everything else is already in `package.json`.

## The fast path

```bash
git clone https://github.com/VnDevTop/NestJs-Boilerplate.git
cd NestJs-Boilerplate
cp .env.example .env
docker compose up --build
```

That is the whole install. It starts Postgres and Valkey, waits for both to
report healthy, runs the migrations, then starts the app and seeds an
administrator whose password is **printed once, at first start**.

- API: <http://localhost:3000/api/v1>
- Swagger: <http://localhost:3000/docs>
- Health: <http://localhost:3000/api/v1/health>

The password is printed to the docker logs and nowhere else. If you lose it,
`docker compose down -v` throws away the volume with the admin row in it and
the next `up` seeds a new one.

```bash
docker compose logs app | grep -i password
```

## Without Docker

```bash
npm install
cp .env.example .env          # edit DATABASE_URL and CACHE_URL to match yours
docker compose up -d postgres valkey   # or point at your own two services
npm run migration:run
npm run seed                   # prints a generated admin password once
npm run start:dev
```

Note the order. `migration:run` builds first, because the TypeORM CLI reads a
compiled `dist/database/data-source.js` — running it against a fresh clone
without a build is the most common first error.

## The two things that bite

### 1. `npm ci` also installs the git hooks

`package.json` has a `prepare` script that runs `husky`, so the commit and
commit-msg hooks are installed by `npm install`. That is deliberate: without
them, a commit that violates the Conventional Commits rule is not caught until
CI.

If the hooks stop running — usually after a `git clone` that skipped install,
or after moving the `.git` directory — restore them:

```bash
npm run prepare
```

### 2. The example secrets do not work in production

`.env.example` ships `JWT_SECRET=change-me` so that a fresh clone boots without
a key-generation step. In development that is fine.

In production the environment validator **rejects the placeholder values** at
boot and names the variable, rather than starting with a key that is published
in this repository. Replace all of them before you deploy:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

That command is the answer for `JWT_SECRET`, `JWT_REFRESH_SECRET` and
`TWO_FACTOR_ENCRYPTION_KEY`. Two of them also rotate: changing
`TWO_FACTOR_ENCRYPTION_KEY` invalidates every stored two-factor secret.

`APP_URL` must be an absolute https URL in production. Every verification and
password reset link is built from it, so a wrong value means a link that leads
nowhere.

## Verifying the install

```bash
curl http://localhost:3000/api/v1/health
```

A healthy deployment reports the database, the cache and the mail transport.
Mail reports `degraded`, not `down`, when no provider is configured — that is
deliberate, so a missing mail provider never takes the API out of rotation.

The application is working when:

- `/api/v1/health` returns 200
- you can sign in at `/docs` with the seeded credentials
- a registered user appears in `mail_logs` (the memory transport records the
  attempt; nothing is actually delivered in development)

## A multi-tenant playground

Tenancy is off by default. Turn it on in `.env` and restart:

```dotenv
MULTI_TENANT=true
TENANT_HEADER=x-tenant-id
```

The seeded `default` tenant already exists. Create a second one with the owner
connection — there is no tenant-creation API, because provisioning is an
operator decision:

```bash
docker compose exec postgres psql -U postgres -d nestjs_boilerplate -c \
  "INSERT INTO tenants (id, slug, name, status, plan) \
   VALUES (gen_random_uuid(), 'acme', 'Acme', 'active', 'free')"
```

Every request now has to say which tenant it is for. The same email can exist in
both, because uniqueness is per tenant:

```bash
BASE=http://localhost:3000/api/v1

curl -s $BASE/auth/register -H 'Content-Type: application/json' \
  -H 'x-tenant-id: default' \
  -d '{"email":"you@example.test","password":"E2e-password-1-Strong","firstName":"You","lastName":"Default"}'

curl -s $BASE/auth/register -H 'Content-Type: application/json' \
  -H 'x-tenant-id: acme' \
  -d '{"email":"you@example.test","password":"E2e-password-1-Strong","firstName":"You","lastName":"Acme"}'
```

Listing users with one header never shows the other tenant's row. Put the
`accessToken` from either registration into `TOKEN` first — the body is
`{ "success": true, "data": { "accessToken": "…" } }`:

```bash
curl -s $BASE/users -H 'x-tenant-id: default' -H "Authorization: Bearer $TOKEN"
curl -s $BASE/users -H 'x-tenant-id: acme' -H "Authorization: Bearer $TOKEN"
```

The application filters by tenant, and the third layer is the database. To see
it, run the migrations and seed as the owner, then point the application at the
`app_user` role the RLS migration creates:

```bash
docker compose exec postgres psql -U postgres -d nestjs_boilerplate -c \
  "ALTER ROLE app_user WITH PASSWORD 'local-app-user'"
```

```dotenv
DATABASE_URL=postgresql://app_user:local-app-user@localhost:5432/nestjs_boilerplate
DATABASE_RLS=true
MULTI_TENANT=true
```

Now a query that forgets its tenant returns no rows at all, rather than another
tenant's. The end-to-end suite runs in exactly this mode:

```bash
E2E_TENANCY_MODE=rls npm run test:e2e
```

## Running the tests

```bash
npm test              # unit and integration, no database needed
npm run test:e2e      # end to end, starts its own Postgres and Redis
```

The end-to-end suite needs a running Docker daemon. Without one:

```bash
E2E_NO_CONTAINERS=1 npm run test:e2e   # every spec skips and says why
```

It will not silently pass on nothing in CI. The CI job omits the flag
deliberately, so a runner that cannot start its containers is a failure rather
than a suite that skipped itself and reported success.

## Updating to a newer version

The schema changes through reviewed migrations, so upgrading is:

```bash
git pull
npm ci
npm run migration:run
npm run seed
npm run build && npm run start:prod
```

`npm run seed` is safe to run repeatedly. It inserts what is missing and never
overwrites — including the mail templates added in Phase 22, whose `.hbs` files
stay the fallback so an upgrade does not undo an operator's edit.

To rehearse a change, take the migrations one at a time and stop before the one
you are unsure of:

```bash
npm run migration:run
npm run migration:revert      # undo the last one
```

TypeORM has no dry-run flag for `migration:run`, and this repository does not
add one — `migration:show` and friends exist in TypeORM but not in the
`package.json` scripts here, so run them through the CLI directly if you want
them:

```bash
npm run build
npx typeorm migration:show -d dist/database/data-source.js
```

The retention job has its own dry run, which is a different thing and does
exist: `RETENTION_DRY_RUN=true`, or `POST /admin/retention/dry-run`.

## Uninstalling

There is nothing to uninstall. Delete the directory, and if you used Docker:

```bash
docker compose down -v
```

The `-v` matters. Without it the named volume survives and your next clone
starts with yesterday's database, which is confusing in a way that reads like a
bug.

## Where to go next

- [Production hardening](production.md) — what to change before real traffic.
- [Optional integrations](optional-integrations.md) — enabling SMTP, BullMQ,
  Telegram, Slack.
- [Operations runbook](runbook.md) — what to do when something breaks at 3am.
