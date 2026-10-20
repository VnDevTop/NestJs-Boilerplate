import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryDeepPartialEntity, Repository } from 'typeorm';

import { AuditLog, type AuditSnapshot } from './entities/index.js';
import { redactText, redactValue } from '../../core/redact/index.js';
import { buildCriteria, readPage } from '../../common/query/index.js';
import { PaginatedResultDto } from '../../common/pagination/index.js';
import { AUDIT_QUERY_SPEC } from './audit-query.js';
import { AuditLogDto } from './dto/audit-log.dto.js';
import type { AuditQueryDto } from './dto/audit-query.dto.js';

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
 * Writes and reads the trail.
 *
 * **The two halves fail in opposite directions, deliberately.**
 *
 * The write never throws: an audit write that failed the action it was
 * recording would mean an outage in the log turns into an outage in the
 * product, and the log is the thing you least want to be taking the application
 * down. A failure is logged at `error` instead, which is the loudest level short
 * of failing the request.
 *
 * That is a real trade and the opposite of the usual advice, so the reasoning is
 * worth stating: the alternative is a deployment where a full audit table or an
 * unreachable database turns every privileged action into a 500. The availability
 * failure is larger, more frequent and more visible than the integrity failure,
 * and an operator reading the gap can see that it happened.
 *
 * The read does the opposite, and it has to. A read that failed and answered
 * "no rows" would be a lie an investigator would act on: "nobody touched this
 * account" and "the database was down" are different facts, and the second one
 * looks exactly like the first until somebody checks the logs. So nothing here
 * catches — a failed read is a failed request.
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
            : (redactValue(entry.before) as AuditSnapshot | null),
        after:
          entry.after === undefined
            ? null
            : (redactValue(entry.after) as AuditSnapshot | null),
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
        // Redacted before the clip, not after. Clipping first is the obvious order
        // and it is wrong: it keeps the first 500 characters, which is precisely
        // where a token in a query string sits. An exception message reaches here
        // verbatim from whatever raised it, and those routinely carry a URL.
        error: entry.error ? redactText(entry.error).slice(0, 500) : null,
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

  /**
   * One page of the trail.
   *
   * **The one call the route makes.** The spec says which fields may be
   * filtered and sorted and which column each one means, the DTO says what the
   * request may contain, and this reads the page. Nothing else in the route
   * knows how a query is built.
   *
   * **Cursor paged, and newest first.** A trail is read backwards from a moment
   * somebody cares about, and the boundary is `(createdAt, id)` — the id breaks
   * the tie, because `createdAt` is `now()` and every row written in one
   * transaction shares it.
   *
   * **No total.** `meta.hasMore` is the honest answer and a count over a year
   * of rows is a second query that goes stale between the two.
   */
  async list(query: AuditQueryDto): Promise<PaginatedResultDto<AuditLogDto>> {
    const criteria = buildCriteria(query, AUDIT_QUERY_SPEC);

    const page = await readPage({
      query: this.repository.createQueryBuilder('entry'),
      criteria,
      alias: 'entry',
    });

    return PaginatedResultDto.of(
      page.items.map((entry) => AuditLogDto.fromEntity(entry)),
      page.meta,
    );
  }
}
