import { BadRequestException } from '@nestjs/common';

/** Ascending or descending. Nothing else: an unknown word is refused, not guessed. */
export type SortDirection = 'ASC' | 'DESC';

export interface ResolvedSort<TField extends string = string> {
  /** The request-facing field name the caller asked for. */
  field: TField;
  /** The database column it maps to. Never taken from the request. */
  column: string;
  direction: SortDirection;
}

/**
 * The sort a route offers, as a map from request field name to column.
 *
 * **The map is the injection boundary.** Sorting by a name a client supplied is SQL
 * injection with a different name — `?sort=createdAt; DROP TABLE users--` reaches
 * the query builder as an identifier, and identifier parameters do not exist, so
 * anything interpolated is a hole. A `const` object fixes that at compile time:
 * there is no path from the request to the column, only from a declared field to
 * its column.
 *
 * It is a map rather than an array so the two things cannot drift apart. A list of
 * allowed fields plus a `column = field` fallback looks equivalent and is not: it
 * invites an entity whose field names are snake_case or abbreviated, and then the
 * fallback silently produces a query that does not mean what the route advertises.
 */
export type SortFieldMap<TField extends string = string> = Readonly<
  Record<TField, string>
>;

/**
 * Turns `?sort=` and `?order=` into a column and a direction, against an allow-list.
 *
 * **An unknown field is a 400 that lists the valid names.** Silently dropping it
 * would answer a different question than the one asked — a client asking to sort
 * by `password` would get a valid page sorted by something else and believe it got
 * what it asked for. Naming the alternatives in the error turns that into a
 * one-line fix for whoever wrote the client.
 */
export function resolveSort<TField extends string>(
  requestedField: string | undefined,
  requestedOrder: string | undefined,
  allowed: SortFieldMap<TField>,
  fallback: TField,
): ResolvedSort<TField> {
  const validNames = Object.keys(allowed).join(', ');

  let field: TField;

  if (requestedField === undefined || requestedField.trim() === '') {
    field = fallback;
  } else {
    const candidate = requestedField.trim();

    if (!Object.prototype.hasOwnProperty.call(allowed, candidate)) {
      throw new BadRequestException(
        `Cannot sort by "${candidate}". Sortable fields: ${validNames}.`,
      );
    }

    // Narrowed by the guard above: `candidate` is a key of `allowed`, so it is a
    // `TField`. Written as a lookup rather than a cast so the compiler checks it.
    field = candidate as TField;
  }

  let direction: SortDirection = 'DESC';

  if (requestedOrder !== undefined && requestedOrder.trim() !== '') {
    const candidate = requestedOrder.trim().toUpperCase();

    if (candidate !== 'ASC' && candidate !== 'DESC') {
      throw new BadRequestException(
        `Cannot sort in order "${requestedOrder}". Use "asc" or "desc".`,
      );
    }

    direction = candidate;
  }

  return { field, column: allowed[field], direction };
}
