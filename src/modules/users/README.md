> **Start with [INTRODUCTION.md](INTRODUCTION.md)** — the user domain and the data-subject rights that attach to it. This file is the detailed reference for _why_ each decision is what
> it is.

# Users

The user domain and the only place that owns the `users` table.

```text
users
├── users.controller.ts
├── users.service.ts
├── entities/user.entity.ts
└── dto/            create, update, response
```

## Entity

```text
id email password firstName lastName role isActive isManager
lastLoginAt createdAt updatedAt deletedAt
```

- `id` is a uuid from the database, not generated in the application.
- `email` is unique and stored lower cased, so `John@example.com` and
  `john@example.com` cannot both exist.
- `deletedAt` is a soft delete. Deleting a user is a `DELETE /users/:id` that
  sets the column; the row stays for audit.
- `isActive` and `isManager` are separate on purpose. `isActive` is
  authentication, `isManager` is scope, and conflating them makes revoking access
  and granting admin scope the same operation.

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

## Open decision

`GET /users/:id` has no role guard, so any authenticated user can read any other
user's profile, email address included. The password hash is withheld, so this is
an information leak rather than a credential leak, but nothing in the code states
that it is intended.

Two reasonable answers: restrict it to the record's own owner plus admins, or
keep it open and accept that the user directory is visible to every signed in
user. Whichever is chosen, it belongs in this file as a decision rather than as an
absence.

`findAll()` also returns every matching row. `PaginationQueryDto` already exists
in `common/dto` for the case that becomes a problem.
