# Auth

> **Start with [INTRODUCTION.md](INTRODUCTION.md)** — the consolidated feature
> summary, the mapping to HIPAA §164.312 / ISO 27001 / OWASP ASVS, and the list
> of gaps a standards audit would find. This file is the detailed reference for
> _why_ each decision is what it is.

Sessions: sign in, refresh, devices and two-factor. The largest module, because
the interesting parts of session handling are not the password check.

```text
auth
├── auth.controller.ts     routes
├── auth.service.ts        register, login, token issuing
├── refresh-token.service.ts  rotation, revocation, theft detection
├── device.service.ts      device fingerprinting and revocation
├── two-factor.service.ts   TOTP setup, verification, recovery codes
├── strategies/            jwt.strategy.ts
├── dto/                   one per request shape
├── entities/              refresh_token, user_device, two_factor_secret
├── enums/                 refresh token revoked reason
└── types/                 payload and metadata interfaces
```

## Token pair

`POST /auth/login` returns a short lived access token and a rotating refresh
token. The access token is stateless; everything that must be revocable lives on
the refresh token row.

## Rotation is the security property

Rotation happens inside a transaction with a pessimistic row lock, so two
concurrent refreshes of the same token produce exactly one winner. The loser gets
a clear failure rather than a second session.

The rotated-out token keeps a `replacedById` pointer, which forms the chain.

**Replaying a token that was revoked by rotation is treated as theft**: all
sessions of that user are revoked. Someone holding a stolen token is not going to
be the only person using it, and invalidating everything is the response that
actually helps. A token revoked by an explicit `POST /auth/logout` does **not**
trigger that sweep, because logging out is not a compromise signal.

## Devices

A device is fingerprinted by user agent, so repeated logins from the same
browser reuse one `user_devices` row instead of creating duplicates. Logging in
again from a revoked device reactivates it rather than failing.

Each `refresh_tokens` row carries a `deviceId`, and rotation keeps the token on
its original device. A session therefore cannot hop to another device while
refreshing, which is what makes `DELETE /auth/devices/:id` meaningful: it
deactivates the device and revokes every token attached to it.

`@DeviceName()` derives a friendly name from the `user-agent` header so clients
send nothing; an explicit `x-device-name` overrides it. Both are untrusted, so the
decorator trims, collapses whitespace and caps the length.

## Two-factor

Optional, and off entirely with `TWO_FACTOR_ENABLED=false`.

- The shared secret is never stored in the clear. It is encrypted with
  AES-256-GCM using `TWO_FACTOR_ENCRYPTION_KEY`, and the auth tag is verified on
  read, so a tampered row fails loudly. Rotating the key invalidates every stored
  secret.
- `POST /auth/2fa/setup` issues a secret but does not enable 2FA.
  `POST /auth/2fa/verify` confirms it, and only then enables 2FA and returns the
  recovery codes, shown once.
- Recovery codes are Crockford base32, stored as salted hashes, and removed from
  the list as they are spent, so the array doubles as the set still usable.
- `POST /auth/login` returns HTTP 200 with a short lived challenge token instead
  of a token pair when 2FA is on. `POST /auth/2fa/login` exchanges the challenge
  plus a code for the real pair.
- TOTP steps are single use. The last accepted counter is persisted, so replaying
  a code inside its own 30 second window is rejected.
- Five invalid attempts locks verification for 15 minutes.

## Rate limits

`@Throttle` tightens the global limit on the routes that accept a secret, because
100 per minute is no defence at all against password guessing.

| Route                            | Limit                                         |
| -------------------------------- | --------------------------------------------- |
| `POST /auth/login`               | 20 / 5 min per client, 10 / 5 min per address |
| `POST /auth/2fa/login`           | same as login                                 |
| `POST /auth/2fa/verify`          | 5 / 5 min                                     |
| `POST /auth/register`            | 10 / 5 min                                    |
| `POST /auth/refresh-token`       | 60 / min per client                           |
| `POST /auth/forgot-password`     | 3 / hour per address, 10 / hour per client    |
| `POST /auth/resend-verification` | 3 / hour per address, 10 / hour per client    |
| `POST /auth/verify-email`        | 10 / hour                                     |

Every limit also sits inside the global one, which is 100 / min.

**Counted in Redis, so it holds across replicas.** The in-memory storage that
ships with the throttler counts inside one process, which makes the number above
the per-replica number. The store is a Lua script because a read followed by a
write lets two concurrent requests both pass, which is the burst being defended
against. It **fails open**: a dead Redis means the request is allowed, because
failing closed would make a cache outage an outage of the whole login route. The
cost is that an outage removes the protection exactly when somebody is most
likely to be hammering the endpoint, which is why the limits here are the inner
layer and not the only one.

**Two buckets, not one.** A per-client limit cannot see an attacker guessing one
account from many hosts, and a per-address limit cannot see an attacker spraying
accounts from one host. Both have to pass, so neither attack works.

**Which bucket a route gets is opt-in.** Every bucket is declared globally,
because the guard builds its list from the module options and nothing else, and
then loops over the whole list on every request. A bucket declared only in
`@Throttle()` is never reached, which is how the per-address mail limit sat
configured and unenforced for several phases. So each bucket carries a `skipIf`
and a route opts in with `@RateLimit('group')`. The polarity is inverted on
purpose: opt-out would put the three-per-hour mail limit on every endpoint.

## Login lockout

There are two, and they answer different questions.

|                | Temporary (`LoginLockoutService`, Phase 17a) | Permanent (`AccountLockService`, Phase 19)         |
| -------------- | -------------------------------------------- | -------------------------------------------------- |
| Where it lives | Redis, with an hour ttl                      | `users.lockedAt`, a column                         |
| Answers        | an attack in progress                        | an attack that has been going all day              |
| Lifts itself   | yes, in minutes                              | never                                              |
| Cleared by     | the clock                                    | the owner of the confirmed address, or an operator |

The temporary one: five failed sign-ins block an address for a minute, each
further failure adds a minute, and the length stops growing at fifteen.

- **The ceiling is the part that matters.** An unbounded multiplier would park an
  account for hours, which is a denial of service dressed up as a defence.
- **Counted for addresses that do not exist too.** Counting only real accounts
  would make the 429 answer which addresses exist without a single successful
  guess. That is the same question `enumeration.spec.ts` works to keep closed.
- **The 429 body does not say how long is left.** The header `Retry-After` does,
  which is enough for a client, and a body naming the time left is a progress bar
  for somebody guessing.
- **The owner is notified once per lockout**, not once per rejected request, and
  never for an address that is not registered. Sending per attempt would turn this
  route into a way to make the application mail somebody repeatedly.
- **It fails open** with the rest of the Redis state.

### The permanent lockout is a weapon before it is a defence

Twenty failed sign-ins lock an account, and twenty requests is nothing. Somebody
with a list of addresses can lock every account in a deployment for the cost of
the list. Three things bound that, and the first is the one the design rests on:

1. **Only a confirmed address can be locked.** An unverified account has never
   proved it can read its mail, so a link to it reaches nobody and the owner is
   locked out until an operator intervenes — exactly the outcome an attacker
   wants. This is a code invariant, not a setting: a config flag for it would be
   one careless default away from locking every account in a deployment.
2. **The owner can always clear it.** The mail goes to the confirmed address, so
   the person _under_ attack holds the way back in, not the person running it.
3. **An operator can always clear it**, for when the address itself is gone.

What is left is a nuisance an attacker can inflict, on an account that can get
itself back in without help.

`ACCOUNT_PERMANENT_LOCK_THRESHOLD` at or below `LOCKOUT_THRESHOLD` is treated as
**disabled**. At that number the permanent lock would fire on the very attempt
that starts the temporary block, and the temporary block lifts on its own — an
account locked and unlocked minutes apart, with a mail in between.

### What a locked account sees

Nothing, and that is the point. `login`, `refresh-token` and `2fa/login` all
answer `Invalid email or password` — the same answer an unregistered address
gets. A dedicated "this account is locked" status or message is a free oracle for
anybody willing to burn twenty attempts on an address, which is the price of the
feature. The owner finds out from the mail, which is the only channel that
reaches the one person who can act on it.

The lock also bumps `sessionsVersion`, so every access token already issued dies
at once. `JwtStrategy` checks `lockedAt` separately and without an exception for
tokens predating the version claim: a lock that left a fifteen minute window open
is the window an attacker who already holds a token is using.

### The unlock routes

```text
POST   /auth/account/unlock         public, throttled — emails the link
POST   /auth/account/unlock/:token  public — spends the token, clears the lock
POST   /auth/account/erasure        authenticated, confirmed address — soft delete
PATCH  /auth/account/:id/unlock     UserWrite — the operator route
```

The admin route lives in `auth` rather than in `users` for one concrete reason:
clearing a lock has to clear the **redis failure count** as well as the row, and
`LoginLockoutService` lives here. Putting it in `users` would mean `UsersModule`
importing `AuthModule`, which imports it right back.

`requestUnlock` pays the same database cost on the miss path and claims no
failure count it does not have — redis forgets within the hour, and a request
usually comes later than that.

## Account enumeration

`forgot-password` and `resend-verification` answer the same way, take the same
time, and do the same database work whether or not the address is registered.

| Defence                                                                             | Why                                                                             |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| One message for every outcome, including an already verified or deactivated account | A different message is an oracle that needs no analysis to read                 |
| The miss path runs the same `UPDATE` against an id with no rows                     | Fewer statements means a faster response, and speed is a signal                 |
| Both paths are held for `TIMING_FLOOR_MS`, with the same jitter on both             | Jittering only the fast path would separate the branches in the other direction |
| No mail is sent on the miss path                                                    | A caller cannot check the promise except by the absence of mail                 |

**The floor is a mitigation, not a proof.** It only holds while the real branch
stays under it. If issuing a token ever takes longer than `TIMING_FLOOR_MS`, that
branch becomes the slow one and the padding equalises nothing.
`enumeration.spec.ts` asserts both branches are held for the floor, which is the
assertion that actually pins it: the difference assertion alone passes even with
the padding removed, because the gap it measures is small.

## What a request is checked against

The JWT is **not** trusted for authorisation. It is trusted for exactly three
things: who the caller is (`sub`), and two counters that decide whether their
sessions are still alive. Everything else is read from the row.

```text
JwtAuthGuard      @Public()? skip : passport calls validate()
  validate()        sub          -> findAuthClaims()  -> cache user:<id>        (60s)
                    sv           -> compare users.sessionsVersion
                    did, dv      -> compare against that device's version
                    sid          -> is the session revoked?
                    role         -> forRole()          -> cache role:<role>     (600s)
  RolesGuard        @Roles()        against request.user.role
  ManagerGuard      @ManagerOnly()  against request.user.isManager, and every /admin/ path
  PermissionsGuard  @Permissions()  against request.user.permissions
```

`email`, `role` and `isManager` are **in the token and ignored**. They are
overwritten from the cached row. That is the whole point: if the role came from
the token, demoting somebody from `admin` to `user` would not take effect for
fifteen minutes. From the cache it takes effect on the next request, because the
write dropped the entry.

Permissions are resolved in the strategy rather than in the guard, so it costs one
read per request rather than one per guarded route.

## Four levels of revocation

Each is scoped to something smaller than the one above it, and each is a
comparison rather than a lookup.

| Scope    | Claim | Bumped by                                              | Leaves alone                          |
| -------- | ----- | ------------------------------------------------------ | ------------------------------------- |
| Account  | `sv`  | `logoutAll`, a password change                         | nothing, it is every device           |
| Device   | `dv`  | signing out of that device, `DELETE /auth/devices/:id` | the user's other devices              |
| Session  | `sid` | `DELETE /auth/sessions/:id`, and a rotation            | the other sessions on the same device |
| User row | —     | deactivation, a role change, a soft delete             | nothing                               |

- **`sv` and `dv` are increments**, never fixed values. A fixed value cannot tell
  a token minted between two logouts from one minted before the first.
- **A claim that is absent is not a claim of zero.** A token minted before a
  column existed carries nothing and is accepted only while the counter is still
  zero, meaning nothing has asked for those sessions to die. Strict equality would
  sign out every signed-in user on deploy, for a token that expires on its own
  anyway.
- **A device that is absent is refused, not skipped.** Retention removes devices
  with no live refresh token, and treating "no such device" as "nothing to check"
  would let a token minted before the deletion keep working.
- **An inactive user fails on their own account first**, before the version is
  compared, so the error does not become a version oracle.

## Revocation is a cache write, not an invalidation

`token:revoked:<session>` is the record of a revoked session, and it is the one
key here that **must not be dropped**: there is no column to re-read it from,
because a revoked session is a `revokedAt` on a row nothing looks up by `jti`.
Deleting it hands the session back.

It carries an exact lifetime, the access token lifetime, with the jitter every
other entry gets switched off. An entry that expires a little early lets the
tokens it revoked start working again.

It is recorded **after** the transaction commits, never inside it. Recorded
before, a rollback leaves a client with a live refresh token and no live access
token at all.

## Sessions and devices are different things

A device is a machine. A session is one live refresh token on it, and rotation
leaves a chain of revoked rows behind exactly one live row per chain.

- `GET /auth/sessions` lists the live ones. Expired and revoked rows are excluded
  by the query, so the list only ever contains something the caller could act on.
- `DELETE /auth/sessions/:id` ends one of them, and the access token already
  minted from it. `DELETE /auth/devices/:id` ends every session on the machine,
  and theirs too.
- Revoking is scoped to the caller, and an id that is not theirs answers exactly
  as one that does not exist. Answering "not yours" would confirm the id is real,
  which is the only thing somebody guessing ids wants to learn.

## Erasure

`POST /auth/account/erasure` marks the account deleted and starts the thirty-day
clock that `RETENTION_SOFT_DELETED_USERS_DAYS` measures.

**It requires a confirmed address, and that is the whole security of the route.**
An erasure is not reversible by the person who asked for it once the grace period
ends, so a request from an unverified account is a request from somebody who cannot
prove the inbox is theirs — which is exactly the shape of an attack: sign somebody
up with their address, then erase the account they cannot get into.

**It is a `POST`, not a `DELETE`,** because it starts a process rather than
performing an act.

`user.requestDeletion()` is a method **on the entity**, not a service method. It
stamps `deletedAt` itself rather than taking it — the timestamp is what the clock is
measured from, and a caller who could set it could skip the grace period by
backdating it — and it writes `deletionReason` at the same time, so the two cannot
be set apart by somebody reaching past it with a repository call.

**A second request does not restart the clock.** Otherwise a user could hold their
account in a half-erased state indefinitely by asking once a day.

**Notification preferences go immediately, the row does not.** That asymmetry is
deliberate: a channel choice is not part of the person, and restoring an account
should not restore "email me about this" for an address that was just erased. The
user row is kept so an erasure made in anger can be reversed.
