import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The paging information every listing route now returns.
 *
 * **`hasMore` rather than a total.** A total is a second query over the same rows
 * to satisfy a number nobody asked for, and it is the number that goes stale
 * between pages: an insert between two requests changes the total on page two, so
 * "page 4 of 12" becomes "page 4 of 13" with a different set behind it. `hasMore`
 * is answered by the page that carries it, which is the only place it can be
 * answered honestly.
 */
export class PageMetaDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example:
      'eyJ2IjoxLCJzIjoiMjAyNi0wOS0yNlQxMDowMDowMC4wMDBaIiwiaSI6IjhhN2QiNm',
    description:
      'Opaque token to pass back as ?cursor= for the next page. Null when ' +
      'hasMore is false.',
  })
  nextCursor!: string | null;

  @ApiProperty({
    example: true,
    description:
      'Whether another page exists after this one. Decided by reading one row ' +
      'past the requested limit, not by counting the table.',
  })
  hasMore!: boolean;

  @ApiProperty({
    example: 20,
    description: 'The page size actually applied, after clamping.',
  })
  limit!: number;
}

/**
 * A page of results and where the next one starts.
 *
 * **A class rather than an interface, because the response interceptor has to
 * recognise it.** The envelope lifts `meta` to the top level, and it can only do
 * that if it can tell a page from an ordinary body. `instanceof` is that test, and
 * it costs nothing at runtime.
 */
export class PaginatedResultDto<TItem> {
  @ApiProperty({ isArray: true })
  items!: TItem[];

  @ApiPropertyOptional({ type: PageMetaDto })
  meta!: PageMetaDto;

  static of<TItem>(
    items: TItem[],
    meta: PageMetaDto,
  ): PaginatedResultDto<TItem> {
    return Object.assign(new PaginatedResultDto<TItem>(), { items, meta });
  }
}
