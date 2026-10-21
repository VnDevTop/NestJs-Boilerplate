import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { DEFAULT_LIMIT, MAX_LIMIT } from '../../../common/constants/index.js';
import { UserResponseDto } from './user-response.dto.js';

/**
 * `POST /users/search` body.
 *
 * **A body rather than a query string.** A search is a sentence somebody typed,
 * and a sentence has spaces, quotes, brackets and colons in it — all of which
 * have to be escaped in a URL and all of which are wrong in one. The body also
 * has room for the facets, which do not fit in a path.
 */
export class UserSearchDto {
  @ApiProperty({
    example: 'ada',
    description:
      'The query, in the search language. A bare word searches the address, ' +
      'the names and the role; `email:ada` and `"ada lovelace"` narrow it.',
  })
  @IsString()
  @MaxLength(500)
  query!: string;

  @ApiPropertyOptional({
    example: 20,
    maximum: MAX_LIMIT,
    default: DEFAULT_LIMIT,
    description:
      'How many results to return. The search returns the best matches, so ' +
      'this is how many of them.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit?: number = DEFAULT_LIMIT;

  @ApiPropertyOptional({
    example: ['role', 'isActive'],
    description:
      'The fields to count. Each one answers "of the rows that matched, ' +
      'how many are in each group", over the very same filter the results ' +
      'use.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(5)
  facets?: string[];

  @ApiPropertyOptional({
    example: 'createdAt',
    description:
      'The field to sort by, instead of the rank. Only a field the entity ' +
      'marks sortable can be named; anything else is refused.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sort?: string;

  @ApiPropertyOptional({
    enum: ['asc', 'desc'],
    default: 'desc',
    description:
      'The direction of the sort. It says nothing about the rank — the score ' +
      'is in every result either way.',
  })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}

/**
 * One match, with the score that put it where it is.
 *
 * **The score is the rank, not a percentage.** `ts_rank` is a number whose
 * meaning depends on the query and the configuration, so a client that shows
 * it as a number out of a hundred would be showing a number that means
 * something else.
 */
export class UserSearchHitDto extends UserResponseDto {
  @ApiProperty({
    example: 0.0918,
    description: 'The rank of this match against the query.',
  })
  score!: number;
}

/** One value of a facet, and how many rows had it. */
export class FacetCountDto {
  @ApiProperty({
    example: 'admin',
    nullable: true,
    description:
      'The value, as text. Every value is a string, whatever the column is, ' +
      'so a client does not have to know the type of the field it asked for. ' +
      'Null for a row whose value is null.',
  })
  value!: string | null;

  @ApiProperty({ example: 12 })
  count!: number;
}

/**
 * The answer to a search.
 *
 * **The results and the counts, and no cursor.** A ranked set is not
 * keyset-paged on a column, because the rank is not a column: a boundary on a
 * floating-point score is a boundary that can be equal or not by a rounding
 * error, and a page that repeats a row or skips one is worse than a search that
 * says "here are the best twenty". A client that needs a specific set filters
 * instead — the language's filters are exact, and the filtering route pages
 * over a column.
 */
export class UserSearchResultDto {
  @ApiProperty({ type: [UserSearchHitDto] })
  items!: UserSearchHitDto[];

  @ApiProperty({
    type: 'object',
    additionalProperties: {
      type: 'array',
      items: { $ref: getSchemaPath(FacetCountDto) },
    },
    description:
      'The counts, per facet field. The counts come from the same filter as ' +
      'the results, so the two cannot disagree about what matched.',
  })
  facets!: Record<string, FacetCountDto[]>;
}
