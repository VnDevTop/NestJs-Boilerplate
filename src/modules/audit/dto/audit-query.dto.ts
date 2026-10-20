import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { CursorPaginationQueryDto } from '../../../common/pagination/index.js';

/**
 * The three values `actorType` can hold.
 *
 * Declared here rather than read off the column so that the filter and the
 * column cannot drift: the entity's doc says the same three, and a fourth value
 * would have to be added in both places.
 */
export const AUDIT_ACTOR_TYPES = ['user', 'system', 'anonymous'] as const;

export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * The two values `outcome` can hold.
 *
 * `success` and `failure`. A failure is the half most systems skip, and it is
 * half of what an investigator asks for.
 */
export const AUDIT_OUTCOMES = ['success', 'failure'] as const;

export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * An ISO-8601 timestamp with an explicit offset.
 *
 * **The offset is required, and this is the reason.** A timestamp without one
 * is interpreted in the *server's* timezone, so `2026-10-20T09:00:00` means
 * different instants on two deployments in different zones — and the two answers
 * are both correct. The window an investigator asks for is "between these two
 * moments", and a boundary that moves with the server's configuration is not a
 * boundary.
 *
 * `Z` and `+02:00` are both accepted; what is refused is the naive form.
 */
const TIMESTAMP_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const TIMESTAMP_MESSAGE =
  'must be an ISO-8601 timestamp with a timezone offset, e.g. 2026-10-20T09:00:00Z';

/**
 * `GET /admin/audit` query parameters.
 *
 * **Every filter here is a question somebody has actually asked.** The actor
 * ("who did this"), the action ("what did they do"), the target ("what did they
 * do it to") and the window ("when") are the four axes of an investigation, and
 * `outcome` and `requestId` are the two that turn a list of entries into a
 * trail: the failures, and the handle that ties a row to the log lines and the
 * mail delivery of the same request.
 *
 * **The filters are declared properties, not a `where` bag.** A DTO that
 * accepted `{ [column]: value }` and passed it to TypeORM would let a caller
 * read any column the entity happens to have. Declaring the filters makes the
 * readable surface exactly the written one, and the global validation pipe's
 * `forbidNonWhitelisted` turns anything else into a 400 naming the field.
 *
 * **The DTO says what the request may contain; the spec says what each field
 * means.** `AUDIT_QUERY_SPEC` is the other half, and the two are checked
 * against each other at compile time — a property here with no filter there,
 * or a filter there with no property here, is an error rather than a parameter
 * the client can send and the route ignores.
 */
export class AuditQueryDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only entries by this actor.',
  })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({
    example: 'ada@example.com',
    description:
      'Only entries by this address, matched as a case-insensitive substring. ' +
      'It is the address the actor had at the time, not the one they have now.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  actorEmail?: string;

  @ApiPropertyOptional({
    enum: AUDIT_ACTOR_TYPES,
    description:
      'Only entries by this kind of actor. `system` is a background job and ' +
      '`anonymous` is a request with no resolvable user.',
  })
  @IsOptional()
  @IsIn(AUDIT_ACTOR_TYPES)
  actorType?: AuditActorType;

  @ApiPropertyOptional({
    example: 'users.update',
    description:
      'Only entries for this action, matched exactly. The action is the ' +
      'dotted name the audit policy gives a route.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  action?: string;

  @ApiPropertyOptional({
    example: 'user',
    description: 'Only entries whose target is of this type.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  targetType?: string;

  @ApiPropertyOptional({
    description:
      'Only entries for this target. A string rather than a uuid, because the ' +
      'target of an entry is not always a row with a uuid.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  targetId?: string;

  @ApiPropertyOptional({
    enum: AUDIT_OUTCOMES,
    description:
      'Only successful entries, or only failures. A refused request is ' +
      'evidence, and it is the half most systems skip.',
  })
  @IsOptional()
  @IsIn(AUDIT_OUTCOMES)
  outcome?: AuditOutcome;

  @ApiPropertyOptional({
    description:
      'Only entries from this request. The handle that ties a row to the log ' +
      'lines and the mail delivery of the same request.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  requestId?: string;

  @ApiPropertyOptional({
    example: '2026-10-20T00:00:00Z',
    description:
      'Only entries at or after this moment. The offset is required: a ' +
      'timestamp without one means different instants on two deployments.',
  })
  @IsOptional()
  @Matches(TIMESTAMP_WITH_OFFSET, { message: TIMESTAMP_MESSAGE })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-10-21T00:00:00Z',
    description:
      'Only entries at or before this moment. The offset is required, for the ' +
      'same reason as `from`.',
  })
  @IsOptional()
  @Matches(TIMESTAMP_WITH_OFFSET, { message: TIMESTAMP_MESSAGE })
  to?: string;
}
