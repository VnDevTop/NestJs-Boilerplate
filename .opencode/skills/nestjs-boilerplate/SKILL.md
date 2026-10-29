---
name: nestjs-boilerplate
description: Project-specific guidance for working in the nestjs-boilerplate repository.
---

# nestjs-boilerplate

## Commands

- Install: `npm install`
- Dev: `npm run start:dev`
- Build: `npm run build`
- Lint: `npm run lint`
- Format: `npm run format`
- Unit tests: `npm test`
- E2E tests: `npm run test:e2e`
- Docker build: `docker build -t nestjs-boilerplate .`

## Conventions

- Default branch is `master`.
- Use Conventional Commits: `type(scope): description`.
- One task per commit.
- Feature work happens on dedicated branches, integrated via pull requests.
- Node.js >= 24 is required.

## CI

GitHub Actions workflows live in `.github/workflows/`:

- `verify.yml`: lint, typecheck, build
- `test.yml`: unit and e2e tests
- `docker.yml`: Docker image build only (no push)
- `codeql.yml`: CodeQL analysis

## Notes

- TypeScript is pinned to 6.x because Nest CLI does not support TypeScript 7 yet.
- `@types/node` is kept on v24 to match the runtime.
- Docker builds use `--ignore-scripts` to avoid running Husky hooks in containers.
