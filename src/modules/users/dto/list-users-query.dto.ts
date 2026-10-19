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
import {
  CursorPaginationQueryDto,
  type SortFieldMap,
} from '../../../common/pagination/index.js';

/**
 * The columns `GET /users` may be sorted on.
 *
 * **Every entry is `NOT NULL`, which the cursor format requires.** A cursor carries
 * its boundary value as a string; a `null` would have to be encoded as something
 * the decoder reads as "malformed", so sortable columns are restricted to ones
 * that always hold a value. Adding a nullable column here means encoding nulls in
 * the cursor and defining what `< NULL` means for a keyset walk — do that
 * deliberately, not by adding a line.
 *
 * `email`, `role` and `isActive` are here because an operator paging a user list
 * asks "the admins", "the inactive ones" — usually as a filter, but sorting by the
 * same columns is what makes a filtered list navigable.
 *
 * `firstName` and `lastName` are absent on purpose. Sorting by either is legal
 * SQL and useless in practice — the answer is "do you mean the full name?" — and
 * an index on either would be maintained forever for a question nobody asks.
 */
export const USER_SORT_FIELDS = {
  createdAt: 'createdAt',
  email: 'email',
  role: 'role',
  isActive: 'isActive',
} as const satisfies SortFieldMap<keyof UserResponseLike>;

/** The shape the allow-list must satisfy, spelled out so a rename is a type error. */
type UserResponseLike = {
  createdAt: unknown;
  email: unknown;
  role: unknown;
  isActive: unknown;
};

/**
 * `GET /users` query parameters.
 *
 * **Filters are declared properties, not a `where` bag.** A DTO that accepted
 * `{ [column]: value }` and passed it to TypeORM would let a caller read any
 * column the entity happens to have — `password` included — and would need a
 * per-entity deny-list to stop it. Declaring the four filters this route supports
 * makes the readable surface exactly the written one, and the global validation
 * pipe's `forbidNonWhitelisted` turns anything else into a 400 naming the field.
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
