import { ApiProperty } from '@nestjs/swagger';

import { AuditLog, type AuditSnapshot } from '../entities/index.js';

/**
 * One audit entry, as the read surface returns it.
 *
 * **The whole row.** An investigator asks a question about an entry and then a
 * question about another field of the same entry — "who changed the role, and
 * what was the role before" — and a DTO that withheld half the row would make
 * the second question another round trip, or worse, answer it from a different
 * entry.
 *
 * **The snapshots are the redacted ones.** `before` and `after` went through
 * `redactValue` when the row was written, so a credential is not in them. What
 * *is* in them is personal data — an address, a role — which is the data the
 * trail exists to record and the reason the route behind it is gated.
 */
export class AuditLogDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description:
      'The actor, by user id. Null for a system or anonymous action.',
  })
  actorId!: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'The address the actor had at the time. A snapshot, not a join, so it ' +
      'still reads correctly after the account is gone.',
  })
  actorEmail!: string | null;

  @ApiProperty({
    enum: ['user', 'system', 'anonymous'],
    description: 'What kind of actor this was.',
  })
  actorType!: string;

  @ApiProperty({
    example: 'users.update',
    description: 'What happened, as `entity.action`.',
  })
  action!: string;

  @ApiProperty({ example: 'user', description: 'What was acted upon.' })
  targetType!: string;

  @ApiProperty({
    nullable: true,
    description: "The target's id, as a string.",
  })
  targetId!: string | null;

  @ApiProperty({
    type: 'object',
    nullable: true,
    additionalProperties: true,
    description:
      'The state before the change. Null for a create, a sign-in or a refusal.',
  })
  before!: AuditSnapshot | null;

  @ApiProperty({
    type: 'object',
    nullable: true,
    additionalProperties: true,
    description: 'The state after the change.',
  })
  after!: AuditSnapshot | null;

  @ApiProperty({
    type: [String],
    nullable: true,
    description: 'The keys that differ between the two states.',
  })
  changedFields!: string[] | null;

  @ApiProperty({ nullable: true, description: 'Where the request came from.' })
  ipAddress!: string | null;

  @ApiProperty({ nullable: true, description: 'The client, as sent.' })
  userAgent!: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'The handle that ties this entry to the log lines and the mail delivery ' +
      'of the same request.',
  })
  requestId!: string | null;

  @ApiProperty({
    enum: ['success', 'failure'],
    description: 'Whether the action succeeded.',
  })
  outcome!: string;

  @ApiProperty({
    nullable: true,
    description: 'The status the request returned.',
  })
  statusCode!: number | null;

  @ApiProperty({
    nullable: true,
    description: 'Why it failed, when the status does not say.',
  })
  error!: string | null;

  @ApiProperty({ example: '2026-10-20T09:12:03.000Z' })
  createdAt!: string;

  /** One row, as the route returns it. */
  static fromEntity(entry: AuditLog): AuditLogDto {
    return {
      id: entry.id,
      actorId: entry.actorId,
      actorEmail: entry.actorEmail,
      actorType: entry.actorType,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      before: entry.before,
      after: entry.after,
      changedFields: entry.changedFields,
      ipAddress: entry.ipAddress,
      userAgent: entry.userAgent,
      requestId: entry.requestId,
      outcome: entry.outcome,
      statusCode: entry.statusCode,
      error: entry.error,
      createdAt: entry.createdAt.toISOString(),
    };
  }
}
