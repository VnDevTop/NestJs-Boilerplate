import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { Role } from '../../../common/enums/index.js';
import { CursorPaginationQueryDto } from '../../../common/pagination/index.js';

/**
 * `GET /users` query parameters.
 *
 * **Filters are declared properties, not a `where` bag.** A DTO that accepted
 * `{ [column]: value }` and passed it to TypeORM would let a caller read any
 * column the entity happens to have — `password` included — and would need a
 * per-entity deny-list to stop it. Declaring the four filters this route supports
 * makes the readable surface exactly the written one, and the global validation
 * pipe's `forbidNonWhitelisted` turns anything else into a 400 naming the field.
 *
 * **The DTO says what the request may contain; the spec says what each field
 * means.** `USER_QUERY_SPEC` is the other half, and the two are checked against
 * each other at compile time — a property here with no filter there, or a filter
 * there with no property here, is an error rather than a parameter the client can
 * send and the route ignores.
 */
export class ListUsersQueryDto extends CursorPaginationQueryDto {
  @ApiPropertyOptional({
    enum: Role,
    description: 'Only users with this role.',
  })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiPropertyOptional({
    example: 'false',
    description: 'Only active or only inactive users.',
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => toOptionalBoolean(value))
  isActive?: boolean;

  @ApiPropertyOptional({
    example: 'true',
    description: 'Only users who have confirmed their email address.',
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => toOptionalBoolean(value))
  isEmailVerified?: boolean;

  @ApiPropertyOptional({
    example: 'example.com',
    description:
      'Case-insensitive substring match on the email address. A `contains`, not ' +
      'a `startsWith`, so a client can search from the domain side.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  email?: string;
}

/**
 * `"true"` and `"false"` as booleans.
 *
 * Query strings carry strings, and `@IsBoolean()` rejects the string `"false"` —
 * which is the exact value a client sends to ask for inactive users. Without this
 * a `?isActive=false` request is a 400, and the natural workarounds are worse: a
 * client that omits the parameter gets *active* users instead of inactive, and
 * answers the opposite question from the one it asked.
 *
 * `undefined` passes through so an absent filter stays absent rather than becoming
 * `false`, which would filter for inactive users on every unfiltered request.
 */
function toOptionalBoolean(value: unknown): unknown {
  if (value === undefined || value === '') {
    return undefined;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') {
      return true;
    }

    if (value.toLowerCase() === 'false') {
      return false;
    }
  }

  return value;
}
