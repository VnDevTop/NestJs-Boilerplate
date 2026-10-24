# Swagger

OpenAPI documentation, served from `setupSwagger(app)`.

```text
GET /docs
GET /docs/admin
```

Configuration comes from `src/configs/swagger.config.ts`, so `SWAGGER_ENABLED=false`
turns it off without a code change.

## Bearer documentation

`addBearerAuth()` is registered on the document, so the "Authorize" button in the
UI produces an `Authorization: Bearer` header for every route that needs one.

## Content-Security-Policy

The CSP is **off** by default, because the Swagger UI needs inline script and
style and a strict policy blocks it. That is a consequence of shipping the docs
from the same origin as the API, not a claim that CSP is unnecessary.

Once a real front end is known, turn `SECURITY_CONTENT_SECURITY_POLICY=true` on
and serve `/docs` only where that is not a concern.

## Keeping the docs honest

Swagger only sees the decorators on controllers, so it drifts silently from the
behaviour. Two things reduce that:

- A response DTO per endpoint, so the schema is declared rather than inferred
  from an object literal.
- A route that returns something other than its declared type, such as the
  two-factor challenge from `POST /auth/login`, is spelled out with `oneOf` in
  `@ApiExtraModels`.
