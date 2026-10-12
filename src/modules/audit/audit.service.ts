import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryDeepPartialEntity, Repository } from 'typeorm';

import { AuditLog, type AuditSnapshot } from './entities/index.js';

/**
 * Who did it. Snapshotted, not joined — see the entity.
 */
export interface AuditActor {
  id: string | null;
  email: string | null;
  /** `user`, `system` or `anonymous`. */
  type: string;
}

export interface AuditContext {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export interface AuditEntry {
  actor: AuditActor;
  /** `entity.action`, e.g. `users.update`. */
  action: string;
  targetType: string;
  targetId: string | null;
  before?: AuditSnapshot | null;
  after?: AuditSnapshot | null;
  outcome: 'success' | 'failure';
  statusCode?: number | null;
  error?: string | null;
}

/**
 * Fields that never reach an audit row, at any nesting depth.
 *
 * **This is the most important thing in the module.** An audit diff is built from
 * whatever object the action was performed on, and that object is usually a `User`
 * entity — which carries a password hash. Writing one into a table that is read by
 * operators, exported to a SIEM, and kept for a year turns a table of "who changed
 * what" into a table of "every credential this system has ever had", in a store
 * that is typically less protected than the database it duplicates.
 *
 * The rule is by name rather than by "looks like a secret", because the shapes
 * change and the names do not. Anything matching is dropped entirely rather than
 * masked: a masked `password: '***'` is still a row saying "this person's password
 * changed", which is useful, but it is also a row inviting somebody to find a way
 * to make the mask fail.
 *
 * `token`, `secret` and `otp` are here for the same reason in the other
 * directions: a reset token, a two-factor secret and a recovery code are all
 * bearer credentials, and all three live on objects an action might be performed
 * on.
 */
const REDACTED_KEYS = new Set([
  'password',
  'newPassword',
  'currentPassword',
  'confirmPassword',
  'token',
  'tokenHash',
  'refreshToken',
  'accessToken',
  'challengeToken',
  'resetToken',
  'verificationToken',
  'secret',
  'twoFactorSecret',
  'otp',
  'code',
  'recoveryCodes',
  'authorization',
  'cookie',
  'sessionSecret',
]);

/** What a redacted value is replaced with. */
const REDACTED = '[redacted]';

/**
 * Recursively drops the sensitive keys from a value about to be stored.
 *
 * Depth-limited, because the input is attacker-controlled in the general case: a
 * body is a diff source for some actions, and a body can nest ten thousand levels
 * deep. Unbounded recursion on that is a stack overflow inside the error handler.
 *
 * Arrays are walked rather than replaced, because a diff of a list of permissions
 * is exactly the kind of thing an audit entry exists for.
 */
export function redactForAudit(
  value: unknown,
  depth = 0,
): AuditSnapshot | unknown {
  if (depth > 12) {
    return '[too deep]';
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactForAudit(entry, depth + 1));
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  const out: AuditSnapshot = {};

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key)
      ? REDACTED
      : redactForAudit(entry, depth + 1);
  }

  return out;
}

/**
 * The keys whose values differ between two states.
 *
 * Sorted, so the same change always produces the same list — an entry compared
 * against a later one for "did anybody else change this field too" should not
 * report a difference caused only by object key order.
 *
 * A `null` side counts as a change against a non-null one, which is what makes a
 * create and a delete readable from the `changedFields` alone.
 */
export function changedFields(
  before: AuditSnapshot | null | undefined,
  after: AuditSnapshot | null | undefined,
): string[] {
  const keys = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);

  return [...keys]
    .filter(
      (key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]),
    )
    .sort();
}

/**
 * Writes one audit row.
 *
 * **It never throws.** An audit write that failed the action it was recording would
 * mean an outage in the log turns into an outage in the product, and the log is the
 * thing you least want to be taking the application down. A failure is logged at
 * `error` instead, which is the loudest level short of failing the request.
 *
 * That is a real trade and the opposite of the usual advice, so the reasoning is
 * worth stating: the alternative is a deployment where a full audit table or an
 * unreachable database turns every privileged action into a 500. The
 * availability failure is larger, more frequent and more visible than the
 * integrity failure, and an operator reading the gap can see that it happened.
 *
 * **Not awaited at the call sites.** A row that takes ten milliseconds to insert is
 * ten milliseconds added to a request that was going to answer anyway.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly repository: Repository<AuditLog>,
  ) {}

  async record(entry: AuditEntry, context: AuditContext): Promise<void> {
    try {
      // `insert` with a plain object rather than `save`. `save` would read the row
      // first to decide whether this is an update, which for an append-only table is
      // a wasted query against a primary key nobody has.
      const row = {
        actorId: entry.actor.id,
        actorEmail: entry.actor.email,
        actorType: entry.actor.type,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        before:
          entry.before === undefined
            ? null
            : (redactForAudit(entry.before) as AuditSnapshot | null),
        after:
          entry.after === undefined
            ? null
            : (redactForAudit(entry.after) as AuditSnapshot | null),
        changedFields:
          entry.before !== undefined || entry.after !== undefined
            ? changedFields(entry.before, entry.after)
            : null,
        ipAddress: context.ipAddress,
        // Capped because both of these are attacker-controlled. An uncapped user
        // agent is a 64KB row written by whoever sent the request.
        userAgent: context.userAgent?.slice(0, 500) ?? null,
        requestId: context.requestId,
        outcome: entry.outcome,
        statusCode: entry.statusCode ?? null,
        error: entry.error?.slice(0, 500) ?? null,
      };

      // One cast, at the boundary. TypeORM's `QueryDeepPartialEntity` distributes
      // over the `| null` on a nullable jsonb column and produces a union it then
      // refuses to accept, which is a limitation of the helper rather than a
      // mismatch here: every field above is already the declared type of its
      // column. Casting once here beats casting the two jsonb fields twice.
      await this.repository.insert(row as QueryDeepPartialEntity<AuditLog>);
    } catch (error) {
      this.logger.error(
        `Could not write the audit entry for ${entry.action}: ${
          error instanceof Error ? error.message : String(error)
        }. The action itself was not affected.`,
      );
    }
  }
}
