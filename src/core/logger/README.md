# Logger

Logging setup. No business code should construct a logger by hand; the container
wires one up in `src/main.ts`.

## Two formats, two audiences

| Environment | Logger                 | Why                                                          |
| ----------- | ---------------------- | ------------------------------------------------------------ |
| development | Nest's `ConsoleLogger` | Coloured, and prints how long each module took to initialise |
| production  | `AppLogger`            | One JSON object per line, with the request id attached       |

The developer number is per module load time, and it is lost the moment output
becomes JSON. So development keeps the format that shows it, and production gets
the format something can parse. Two formats for two audiences beats one for
neither.

```ts
const logger =
  env === 'production'
    ? createAppLogger()
    : new ConsoleLogger({ logLevels, timestamp: env === 'development' });

Logger.overrideLogger(logger);
```

`overrideLogger` is called **before** `NestFactory.create`, because module
resolution logs through the static `Logger` while the graph is still being built.
Without it, those lines go somewhere else and production ends up with two
formats in one file.

## Production output

```json
{
  "timestamp": "2026-01-01T00:00:00.000Z",
  "level": "error",
  "context": "CacheModule",
  "requestId": "...",
  "message": "Cache unavailable: connect ECONNREFUSED"
}
```

- One object per line, so a shipper does not need a multi-line parser.
- An `Error` is serialised with its name, message and stack, rather than `{}`.
- A multiline message stays on one line, because a stack trace would otherwise be
  read as several records.
- The `requestId` comes from the `AsyncLocalStorage` in
  `src/common/utils/request-id.util.ts`, so it is attached without the call site
  passing it.

## Levels

`error`, `warn`, `log`, `debug`, `verbose`, in that order. Anything not in the
list is dropped, which is the cheapest way to silence a chatty dependency in
production without touching its code.

## The logger can never throw

Three ways it could, all real:

| Failure                              | Why it matters                                                             |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `JSON.stringify` on a cyclic payload | the most likely; a logger that throws breaks the request it was describing |
| a value whose `toJSON` throws        | a library's error object serialising a request that no longer exists       |
| a closed stream during shutdown      | a log line with nowhere to go                                              |

An exception escaping a `logger.error` inside a catch block replaces the original
error with an unrelated one. That is the one line written to explain the fault,
gone — so every path here is defensive: the entry is rendered with a replacer that
turns a cycle into `[circular]`, and a failure to write falls back to a minimal
line rather than propagating.

## Everything is redacted on the way in

See [src/core/redact/README.md](../redact/README.md). Both passes run here, and an
`Error` is handled explicitly — once flattened, its `message` and `stack` are
strings, and the key-based pass sees nothing inside a string.
