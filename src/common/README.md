# Common Layer

Reusable building blocks. Nothing here may know about a business module.

```text
common
├── constants     metadata keys, header names, app wide limits
├── decorators    @Public, @CurrentUser, @Roles, @ManagerOnly, @Permissions, @DeviceName
├── dto           PaginationQueryDto and other shared shapes
├── enums         Role
├── filters       AllExceptionsFilter, HttpExceptionFilter
├── guards        JwtAuthGuard, RolesGuard, ManagerGuard, PermissionsGuard
├── interceptors  ResponseTransformInterceptor
├── interfaces    ApiResponse, JwtPayload, RequestUser
├── middlewares   RequestIdMiddleware
├── pipes         global validation pipe
└── utils         password, encryption, recovery codes, user agent, request id
```

## Rules

- No imports from `modules`. If something here needs business data, it takes it
  from the request instead.
- Guards read the request context rather than injecting a feature service. A
  guard that loads users to check a role is a guard that can fail in a way the
  caller cannot interpret.
- Metadata keys live in `constants/metadata.constants.ts`, never as inline
  strings, so a rename cannot leave a decorator and its guard disagreeing.
- A utility that is only ever used by one module belongs in that module.

## Middleware

`RequestIdMiddleware` gives every request an `X-Request-Id` and keeps it in an
`AsyncLocalStorage`, so a log written deep inside a service can correlate without
the call site knowing anything about requests.

A caller supplied id is reused only when it is 8 to 64 characters of a restricted
charset. A newline in that value would let a caller forge or split log entries.
Node's HTTP parser rejects such a header with a 400 before it reaches a handler,
so this is defence in depth rather than the thing standing between a caller and
a forged log line.

The middleware is platform independent. Express and Fastify share no request or
reply type, so it declares the parts it uses itself and sets the header with
`header()`, which is the one spelling both have. `catchAllRoute` picks the route
pattern per adapter, because `path-to-regexp` v8 and `find-my-way` spell a
catch-all differently and neither accepts the other's.

## Filters

`HttpExceptionFilter` shapes anything the application threw on purpose, and
`AllExceptionsFilter` catches the rest and logs it, and reports it to Sentry when
`@sentry/node` and a DSN are present — with the request headers, cookies, body and
query string stripped, because that is where credentials arrive. A 4xx is not logged: it is a
client mistake, and logging every one buries the failures that matter.

## Interceptors

`ResponseTransformInterceptor` wraps successful responses in the standard
`ApiResponse` envelope, so the shape is decided in one place.

## Utilities worth knowing

| Utility                       | Note                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `utils/password.util.ts`      | scrypt hashing, plus `generatePassword` for seeds                             |
| `utils/encryption.util.ts`    | AES-256-GCM with the auth tag verified on read                                |
| `utils/recovery-code.util.ts` | Crockford base32, no I/L/O/U, so a code read aloud is not mistyped            |
| `utils/user-agent.util.ts`    | dependency free best effort; swap for `ua-parser-js` if coverage matters more |
| `utils/request-id.util.ts`    | generation, sanitising, and the async context                                 |

Each has a test next to it where the behaviour is worth pinning.
