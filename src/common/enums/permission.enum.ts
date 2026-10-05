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

  /** Read what the application last sent and to whom. */
  MailLogRead = 'mail-log:read',
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
    ]),
  });
