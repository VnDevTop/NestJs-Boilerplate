# Project Structure

## Top-level layout

- `src/` — application source code.
- `src/common/` — cross-cutting building blocks shared across modules:
  - `config/`, `decorators/`, `dto/`, `exceptions/`, `filters/`, `guards/`,
    `interceptors/`, `pipes/`, `utils/`.
- `src/config/` — typed configuration factories (registered via `registerAs`)
  and environment validation.
- `src/database/` — TypeORM base entities, data source and migrations.
- `src/modules/` — feature modules (auth, users, health, mail, cache, queue, i18n,
  http, compliance).
- `test/` — unit and e2e tests.
- `docs/` — project documentation.

## Conventions

- Each folder exposes a barrel `index.ts` where useful.
- Configuration is split into small files (`*.config.ts`) and registered with
  `registerAs` so modules can consume them via `config.asProvider()`.
- Environment variables are validated at startup with zod
  (`src/config/env.validation.ts`).
- Entities extend `src/database/base.entity.ts`.
- Migrations live in `src/database/migrations/`.