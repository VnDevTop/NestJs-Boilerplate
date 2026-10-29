# nestjs-boilerplate

A production-ready [NestJS](https://nestjs.com) boilerplate built with TypeScript, Vitest, Oxlint, and GitHub Actions.

## Features

- NestJS 12 with TypeScript 6
- Vitest for unit and e2e tests
- Oxlint for fast linting
- Prettier for formatting
- Husky + Commitlint (Conventional Commits)
- Docker multi-stage build
- GitHub Actions: verify, test, docker build, CodeQL

## Requirements

- Node.js >= 24
- npm >= 11

## Getting started

```bash
npm install
npm run start:dev
```

The server listens on `http://localhost:3000`.

## Scripts

| Script | Description |
| --- | --- |
| `npm run build` | Compile the application |
| `npm run start` | Start the application |
| `npm run start:dev` | Start in watch mode |
| `npm run start:debug` | Start in debug watch mode |
| `npm run start:prod` | Start compiled application |
| `npm run lint` | Run Oxlint |
| `npm run format` | Run Prettier |
| `npm test` | Run unit tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:cov` | Run tests with coverage |
| `npm run test:e2e` | Run e2e tests |

## Docker

```bash
docker build -t nestjs-boilerplate .
docker run --rm -p 3000:3000 nestjs-boilerplate
```

## Project structure

```text
src/
  app.controller.ts
  app.module.ts
  app.service.ts
  main.ts
test/
  app.e2e-spec.ts
```

## Contributing

Please follow [Conventional Commits](https://www.conventionalcommits.org/). Commit messages are validated by Commitlint via Husky.

## License

MIT
