import { Role } from './role.enum.js';

/**
 * Every permission the application recognises.
 *
 * The values are the database column contents, and the guard compares against
 * them, so a rename here is a breaking change: it needs a data migration to
 * rewrite `role_permissions.permissionId`, not just a deploy.
 *
 * Declared here rather than as rows discovered at runtime so a permission used in
 * a `@Permissions()` decorator but missing from the seed is a mismatch a test can
 * catch, rather than a route that silently refuses everyone who reaches it.
 */
export enum Permission {
  /** Read the dashboard and health payload. */
  AdminHealthRead = 'admin:health:read',

  /** Read the mail template list and preview a template. */
  MailTemplateRead = 'mail-template:read',

  /** Create, edit or delete a mail template. */
  MailTemplateWrite = 'mail-template:write',

  /** Read a user record that is not the caller's own. */
  UserRead = 'user:read',

  /** Create or modify a user. */
  UserWrite = 'user:write',

  /** Soft-delete a user, which is the start of the erasure flow. */
  UserDelete = 'user:delete',

  /** Run the retention job by hand or read its history. */
  MaintenanceRun = 'maintenance:run',

  /**
   * Read what a job is doing: its status, how far it has got and why it failed.
   *
   * Operational data about work the application is doing right now. Reading it
   * changes nothing, so an administrator may.
   */
  JobRead = 'job:read',
  /**
   * Ask a running job to stop.
   *
   * Held by the super administrator alone, like `MaintenanceRun` and
   * `UserDelete`. Stopping a job is irreversible and leaves the work half
   * done: a cancelled import has written some of its rows and not the rest,
   * and a cancelled cleanup has left tables unclean. The person who starts a
   * job is not always the person who should be able to stop it, which is why
   * watching and stopping are two permissions rather than one.
   */
  JobCancel = 'job:cancel',

  /**
   * Read the audit trail.
   *
   * Held by the super administrator alone, and the reason is not that the trail
   * is dangerous to look at. It is *who* it describes: every privileged actor,
   * with the failures included, because a refused request is evidence.
   *
   * An administrator already holds `UserRead`, so the personal data in the
   * snapshots is not new to them. What is new is reading the conduct of their
   * peers — and the manager gate cannot be the thing that decides it, because
   * `isManager` is a column an administrator can set on any account through
   * `PATCH /users/:id`. A gate the people the trail reports on can widen is not
   * a gate.
   *
   * The cost is stated rather than hidden: an ordinary administrator
   * investigating an incident needs an escalation. That is the right default for
   * the one read surface that describes what the operators did.
   */
  AuditRead = 'audit:read',

  /** Read what the application last sent and to whom. */
  MailLogRead = 'mail-log:read',

  /**
   * Read which permissions a role holds.
   *
   * Separate from the write below because the two answer different questions, and
   * reading them is what an admin screen needs to render the current state without
   * being able to change it.
   */
  RoleRead = 'role:read',

  /**
   * Replace a role's grants.
   *
   * The most dangerous permission in the list, and the reason the route is written
   * to fail rather than to grant: a mistyped name refuses the request, and a role
   * whose grants are emptied is a role nobody can reach. Held by the super
   * administrator alone, because it is the one permission that can revoke another
   * administrator's access.
   */
  RoleWrite = 'role:write',
}

/**
 * Which role holds which permission on a fresh install.
 *
 * A total order by intent rather than by hierarchy: `SuperAdmin` holds everything
 * an `Admin` holds plus the destructive and operational permissions, and a plain
 * `User` holds none. A user reaching a guarded route is refused rather than
 * allowed through a default, so an unseeded permission denies instead of grants.
 *
 * Kept next to the enum because the two have to agree. A permission in the enum
 * that no role holds is a route nobody can reach, and a role entry naming a
 * permission that is not in the enum cannot be seeded.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> =
  Object.freeze({
    [Role.User]: Object.freeze([]),

    [Role.Admin]: Object.freeze([
      Permission.AdminHealthRead,
      Permission.MailTemplateRead,
      Permission.MailLogRead,
      Permission.UserRead,
      Permission.UserWrite,
      // Watching a job is reading, and reading is safe. Stopping one is not,
      // so `JobCancel` is not here.
      Permission.JobRead,
      // `AuditRead` is not here either, and that is a decision rather than an
      // omission: it is the trail of what every privileged actor did, and an
      // administrator is one of them. See the permission's own comment.
      // Read only. Granting an administrator the permission that edits roles would
      // let one administrator grant themselves another administrator's, which is
      // why `RoleWrite` is not here.
      Permission.RoleRead,
    ]),

    [Role.SuperAdmin]: Object.freeze([
      Permission.AdminHealthRead,
      Permission.MailTemplateRead,
      Permission.MailTemplateWrite,
      Permission.MailLogRead,
      Permission.UserRead,
      Permission.UserWrite,
      Permission.UserDelete,
      Permission.MaintenanceRun,
      Permission.JobRead,
      Permission.JobCancel,
      Permission.AuditRead,
      Permission.RoleRead,
      Permission.RoleWrite,
    ]),
  });
