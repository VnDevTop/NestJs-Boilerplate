# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/VnDevTop/NestJs-Boilerplate/security/advisories/new),
or by email to <hi@vndev.top>.

Include what an attacker can do, how to do it, and which version or commit is
affected. A proof of concept is more useful than a description.

You will get an acknowledgement within a few days and an assessment once it has
been reproduced. Please give the maintainers reasonable time to publish a fix
before disclosing.

## What is in scope

This is a template, so "the application" is what someone builds with it. Reports
about the template itself are in scope when the problem is in the code that ships
here:

- The authentication and session handling in `src/modules/auth`.
- The authorisation guards in `src/common/guards`.
- The environment validation, rate limiting and request id handling.
- Anything in the Dockerfile, the CI workflow or the compose stack.

## Known limitations

These are recorded rather than presented as fixed. Each is in
[ROADMAP.md](ROADMAP.md#open-decisions) with the decision that has not been made.

- **A dead Redis removes rate limiting and the login lockout.** Both fail open, so
  an outage that overlaps an attack removes that protection rather than locking
  users out. Put a limit in front of the application as well; these are the inner
  layer.
- **The login lockout can be inflicted on a victim.** Five wrong passwords for an
  address block it for a minute, more for longer, up to fifteen minutes. Anyone
  can trigger that, and the owner of the address is the person least able to sign
  in while it lasts. It is keyed by address rather than by account so a 429 cannot
  reveal which addresses exist.
- **`GET /users/:id` has no role guard.** Any authenticated user can read another
  user's profile, email address included. The password hash is withheld, so this
  is an information leak rather than a credential leak.
- **`TWO_FACTOR_ENCRYPTION_KEY` has a default.** The configuration falls back to a
  published value when the variable is unset. Startup validation rejects that in
  production, but only when 2FA is enabled, so an unset key with 2FA off is not
  an error by design.
- **Auth state is read from the database on every request**, not from the cache,
  so a deactivated account or a changed role takes effect at once. That costs one
  query per request.
- **The compose stack uses development secrets.** `docker-compose.yml` is for
  local work and is not a production deployment.

## Deploying this

The defaults that matter before a real deployment:

- Generate real secrets. Startup validation rejects a secret that still holds a
  value from `.env.example`, and requires at least 32 characters in production.
- Set `CORS_ORIGINS` to an explicit allow-list. Leaving it empty is same-origin
  only, which is correct for an API not called from a browser.
- Keep `CORS_CREDENTIALS=false` unless the API is called from a browser with
  cookies. Validation rejects credentials combined with a wildcard origin.
- Terminate TLS in front. The HSTS header only takes effect over HTTPS.
- Turn `SECURITY_CONTENT_SECURITY_POLICY=true` on once a real front end is known.
  It is off by default because the Swagger UI needs inline script and style.
- Run `npm run check` in CI. The workflow does it already.
- Back up the database and know how to restore it before the first deploy, not
  after the first incident.
