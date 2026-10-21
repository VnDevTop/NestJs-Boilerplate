> **Start with [INTRODUCTION.md](INTRODUCTION.md)** — the user domain and the data-subject rights that attach to it. This file is the detailed reference for _why_ each decision is what
> it is.

# Users

The user domain and the only place that owns the `users` table.

```text
users
├── users.controller.ts
├── users.service.ts
├── entities/user.entity.ts
└── dto/            create, update, response, list query
```

## Entity

```text
id email password firstName lastName role isActive isManager
lastLoginAt createdAt updatedAt deletedAt searchVector
```

- `id` is a uuid from the database, not generated in the application.
- `email` is unique and stored lower cased, so `John@example.com` and
  `john@example.com` cannot both exist.
- `deletedAt` is a soft delete. Deleting a user is a `DELETE /users/:id` that
  sets the column; the row stays for audit.
- `isActive` and `isManager` are separate on purpose. `isActive` is
  authentication, `isManager` is scope, and conflating them makes revoking access
  and granting admin scope the same operation.
- `searchVector` is a **generated** column: the searchable text of the row, with
  each field's weight baked in, computed by postgres on every write. It is
  generated rather than filled by a trigger because a trigger is a thing that can
  miss a write, and a search index that is wrong answers "no such user" for a
  user that exists. See [the search layer](../../common/README.md#the-search-language).

## Passwords

Hashed with scrypt in `src/common/utils/password.util.ts`, with a per-row salt. The
entity field holds `salt:derivedKey`; the plain password never reaches the
database and `UserResponseDto` has no property for it, so a response cannot leak
it even by accident.

## Authorisation on the routes

| Route               | Guard                       |
| ------------------- | --------------------------- |
| `POST /users`       | `@Roles(Admin, SuperAdmin)` |
| `GET /users`        | `@Roles(Admin, SuperAdmin)` |
| `PATCH /users/:id`  | `@Roles(Admin, SuperAdmin)` |
| `DELETE /users/:id` | `@Roles(Admin, SuperAdmin)` |
| `GET /users/:id`    | authenticated only          |

## Searching users

`POST /users/search` takes a body — a search is a sentence somebody typed, and a
sentence has spaces, quotes, brackets and colons in it, all of which have to be
escaped in a URL and all of which are wrong in one.

```json
{ "query": "ada", "limit": 20, "facets": ["role"] }
```

The query is in the search language, and the field map in
[users-search.ts](./users-search.ts) says what the fields mean. A bare word
searches the address, the names and the role; `email:ada`, `"ada lovelace"` and
`role:admin` narrow it. The answer is the best matches, each with the rank that
put it where it is, and the counts of the matching rows per facet.

**It is behind `user:read`** — the permission to read a user record. The search
reads user records and finds them by name, so the permission that says a caller
may read a user record is the one that says they may find one.

**There is no second page.** A ranked set is not keyset-paged on a column,
because the rank is not a column, and a boundary on a floating-point score is a
boundary that can be equal or not by a rounding error. A client that needs a
specific set filters instead — the filters are exact, and `GET /users` pages over
a column.

## Listing users

`GET /users` is cursor paged on `(createdAt, id)`. See
[common/pagination](../../common/README.md#pagination) for the shared layer; the
parts that belong to this route:

- **Four sortable columns**, `createdAt`, `email`, `role`, `isActive`, declared
  as a map in `dto/list-users-query.dto.ts`. `firstName` and `lastName` are
  absent: sorting by either is legal SQL and useless in practice, and an index on
  either would be maintained forever for a question nobody asks.
- **Four filters**, `role`, `isActive`, `isEmailVerified` and an `email`
  substring, as declared properties. Every one is bound as a value, and the
  `%`/`_` a caller types are escaped, so a search for `a_%b` finds addresses
  containing a percent sign rather than every row on the table.
- **`?isActive=false` works.** `@IsBoolean()` rejects the string `"false"`, which
  is the exact value a client sends to ask for inactive users — and the natural
  workarounds are worse, because omitting the parameter returns _active_ users.
- **No `total`.** `meta.hasMore` is the honest answer and it is carried by the
  page it belongs to.

## Open decision

`GET /users/:id` has no role guard, so any authenticated user can read any other
user's profile, email address included. The password hash is withheld, so this is
an information leak rather than a credential leak, but nothing in the code states
that it is intended.

Two reasonable answers: restrict it to the record's own owner plus admins, or
keep it open and accept that the user directory is visible to every signed in
user. Whichever is chosen, it belongs in this file as a decision rather than as an
absence.
