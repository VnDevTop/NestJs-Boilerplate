# Contributing

Thanks for considering it. This project is meant to be read as much as used, so
the bar is mostly about clarity rather than cleverness.

## Getting set up

```bash
git clone https://github.com/VnDevTop/NestJs-Boilerplate.git
cd NestJs-Boilerplate
npm install          # also installs the git hooks through the prepare script
cp .env.example .env
```

You need Node 22 or newer. Then a database and a cache:

```bash
docker compose up -d postgres valkey
npm run migration:run
npm run seed         # prints a generated admin password once
npm run start:dev
```

The app is on `http://localhost:3000/api/v1`, the docs on `/docs`.

## Before you push

```bash
npm run check
```

That is lint, typecheck, test and build, in the same order CI runs them. Running
it locally is faster than finding out in CI.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), enforced
by commitlint in the `commit-msg` hook:

```text
type(scope): subject
```

- `type` is one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
  `build`, `ci`, `chore`, `revert`.
- The subject is lower case, imperative, and under 72 characters including the
  header.
- Explain **why** in the body when the change is not obvious from the diff. The
  diff already says what changed.

```text
fix(auth): treat a rotated refresh token replay as theft

The rotated-out token is never usable, so seeing it again means someone kept a
copy. Revoking every session of that user is the response that helps, where
revoking only the one session leaves the attacker in.
```

A commit that is only formatting is `chore:`, and `refactor:` is for behaviour
that does not change. A `feat:` that a user could notice is a `feat:`.

## Staged files

The `pre-commit` hook runs Prettier and `oxlint --fix` on staged files only, so a
commit never reformats work that is not part of it. If the hook rewrites
something, stage it again and commit.

Husky writes to `.husky/_`, which is gitignored. If the hooks stop running after
cloning, `npm run prepare` restores them.

## Code conventions

- Prettier, with no configuration to argue about. Run it, do not fight it.
- `oxlint` for lint. No `any` unless there is a comment saying why.
- Named exports. `src/**/index.ts` is the public surface of a folder, and it
  re-exports only what other code should be using.
- No `process.env` outside `src/configs`, and outside a CLI that runs without the
  Nest container, such as `src/database/data-source.ts`.
- Controllers stay thin. Business logic goes in a service.

### Where code goes

|                                    |                                                                    |
| ---------------------------------- | ------------------------------------------------------------------ |
| A business feature                 | `src/modules/<name>`, with its own README                          |
| A capability the whole app needs   | `src/core/<name>`                                                  |
| Something reusable across features | `src/common`, which may not know what your business does           |
| A configuration namespace          | `src/configs/<name>.config.ts`, plus a rule in `env.validation.ts` |

The rules for each layer are in the README inside it. Read the one you are
adding to before you start.

## Tests

```bash
npm test
npm run test:watch
```

Tests sit next to what they test, named `*.spec.ts`. They should use an in-memory
store rather than a real dependency, so `npm test` needs nothing running.

A change to behaviour comes with a test that fails without it. For anything where
the "obvious" implementation is wrong, measure first and put the numbers in the
code: the cache, the throttler and the request id all have comments explaining
what was actually observed.

## Documentation

A change to behaviour updates the README of the folder that owns it, in the same
commit. An entry in a plan saying something is done is not documentation of how
it works.

## Pull requests

1. Branch from `master`.
2. Make the change, with a test if it is behaviour.
3. Run `npm run check`.
4. Open the PR describing what changed and why. Screenshots for anything visual.
5. Keep one concern per PR. A refactor and a feature in one commit cannot be
   reviewed, only trusted.

## Reporting a bug

Open an issue with what you did, what happened, and what you expected instead. A
failing test or a log line with the request id is worth more than a description.

Security issues should not go through the public tracker. See
[SECURITY.md](SECURITY.md).
