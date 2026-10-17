import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { DEFAULT_LIMIT, MAX_LIMIT } from '../constants/index.js';

/**
 * The paging parameters every listing route accepts.
 *
 * **`cursor` and no `page`.** Offset paging reads as `?page=4` and is quietly
 * wrong: a row inserted between two requests shifts everything after it by one, so
 * the row the client already saw on page three appears again on page four. Nothing
 * errors, the counts line up, and the client has to de-duplicate rows it was
 * promised were unique. A cursor names the boundary it stopped at, so an insert
 * ahead of the reader cannot move it.
 *
 * There is no total and no last page, and that is deliberate — see `PageMetaDto`.
 * A client that needs a total has to walk to the end, which is the honest cost of
 * a consistent snapshot and cheaper than a count that lies.
 *
 * `limit` is clamped rather than refused, matching the retention history route: a
 * client asking for more than the ceiling is careless rather than wrong, and a 400
 * teaches it that the route is fragile.
 */
export class CursorPaginationQueryDto {
  @ApiPropertyOptional({
    example: 20,
    maximum: MAX_LIMIT,
    default: DEFAULT_LIMIT,
    description:
      'Rows per page. Values above the ceiling are clamped, not refused.',
  })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit: number = DEFAULT_LIMIT;

  @ApiPropertyOptional({
    description:
      'The nextCursor from a previous response. Opaque — pass it back unmodified. ' +
      'A malformed cursor is a 400 rather than a silent first page.',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    description:
      'Which column to sort on. Each route declares its own allow-list; ' +
      'anything else is a 400 listing that route’s sortable fields. Newest first ' +
      'unless `order=asc`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sort?: string;

  @ApiPropertyOptional({
    enum: ['asc', 'desc'],
    default: 'desc',
    description:
      'Sort direction. Applied to the route’s allow-listed sort field.',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  /**
   * The clamped page size.
   *
   * Separate from the property because `class-transformer` will happily hand back
   * a value that failed `@Max` when the DTO is used without the global validation
   * pipe — a unit test, or a consumer that instantiates it directly. Clamping at
   * the point of use means an oversized request cannot reach the query builder even
   * if it got this far.
   */
  get effectiveLimit(): number {
    if (!Number.isFinite(this.limit)) {
      return DEFAULT_LIMIT;
    }

    return Math.min(Math.max(Math.trunc(this.limit), 1), MAX_LIMIT);
  }
}
