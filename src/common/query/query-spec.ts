import type { FilterOperator } from './filter-operator.js';

/**
 * One filterable field of an entity, as the query layer sees it.
 *
 * **The column is declared here and nowhere else.** A filter that carried its
 * own column name would be a filter that could name a column, and a column
 * name is an identifier — an identifier cannot be a bound parameter, so it
 * would have to be interpolated. This is the same boundary Phase 23 drew for
 * sorting, applied to filtering.
 */
export interface FilterFieldSpec {
  /**
   * The database column this field filters on.
   *
   * **Always quoted when it reaches SQL.** It is declared in source, so it is
   * trusted — but quoting costs nothing and means a column named `order` or
   * `user` is a column and not a keyword.
   */
  readonly column: string;

  /**
   * The comparison this field makes.
   *
   * Declared per field, so a field that only makes sense one way says so. A
   * `role` filters with `eq`; a `createdAt` filters with `gte` or `lte`.
   */
  readonly operator: FilterOperator;

  /**
   * The operators the client may choose between, when there is more than one.
   *
   * A request says *what* to filter by, not *how*: `?createdAfter=2026-01-01`
   * names the field and the value, and the operator comes from here. Without
   * this, a route that wants to offer both a lower and an upper bound would
   * need two fields, and a route that wanted to let the client choose would be
   * one interpolation away from a hole.
   *
   * Absent means the single operator above is the only one.
   */
  readonly operators?: readonly FilterOperator[];

  /**
   * Whether the value is a list rather than a scalar.
   *
   * A list is expanded into `IN (...)` by TypeORM, one placeholder per
   * element, so the elements remain parameters.
   */
  readonly list?: boolean;
}

/**
 * The fields of one entity that a client may filter on.
 *
 * Keyed by the **request-facing name**, which is the name the query DTO
 * declares. A request says `?role=admin`, and `role` here is the key; the
 * column it lands on is a separate fact.
 *
 * The type parameter is the set of names the DTO allows, so a DTO that
 * declares a field the spec does not, or a spec that names a field the DTO
 * does not, is a compile error rather than a filter that silently never fires.
 */
export type FilterFieldMap<TField extends string = string> = Readonly<
  Record<TField, FilterFieldSpec>
>;

/**
 * The sortable fields of one entity, keyed by request-facing name.
 *
 * The same shape and the same reasoning as `FilterFieldMap`: the key is what
 * the client asks for, the column is where it lands.
 *
 * **A plain string rather than an object**, because a sortable field has exactly
 * one fact about it — which column it lands on — and an object with one
 * property is noise. The filter map is an object because a filter has two:
 * the column and the comparison.
 */
export type SortFieldMap<TField extends string = string> = Readonly<
  Record<TField, string>
>;

/**
 * Everything one entity's list route allows.
 *
 * **The whole of a route's query surface in one object.** A route that
 * declares a spec has, by construction, a closed set of filterable and
 * sortable fields — and a field that is not in the spec cannot be filtered on
 * or sorted by, no matter what the client sends.
 */
export interface QuerySpec<TFilter extends string = string> {
  /** The fields a client may filter on. */
  readonly filters: FilterFieldMap<TFilter>;

  /** The fields a client may sort by. */
  readonly sort: SortFieldMap;

  /**
   * The sort used when the client does not ask for one.
   *
   * **Named, and it must be a sortable field.** A default that is not in the
   * sort map would produce a query ordering by a column the client cannot
   * even name, which is a rule nobody can discover from the API.
   */
  readonly defaultSort: string;
}

/**
 * The keys of a DTO that are filters rather than paging.
 *
 * **The paging keys are excluded by name.** A DTO that extends
 * `CursorPaginationQueryDto` has `limit`, `cursor`, `sort` and `order` on it,
 * and those are not filters — they are read by the criteria builder itself.
 *
 * `effectiveLimit` is excluded too, and it is not a paging key but a getter: it
 * is a derived value, not something a client sends.
 */
export type FilterKeys<TDto> = Exclude<
  keyof TDto,
  'limit' | 'cursor' | 'sort' | 'order' | 'effectiveLimit'
>;

/**
 * Declares a route's query surface, checked against its DTO.
 *
 * **The filter keys are checked against the DTO, in both directions.** A filter
 * here that the DTO does not declare is a compile error, and so is a DTO
 * property that no filter declares:
 *
 * - A filter the DTO does not declare could never arrive — the global
 *   validation pipe strips a parameter the DTO does not name — so it would be
 *   a filter that can never fire.
 * - A DTO property that no filter declares is a parameter the client can send,
 *   the pipe will keep it, and the route will ignore it. A client that sends
 *   `?isActive=false` and gets the unfiltered list has been told a lie, and
 *   nothing in the code says the filter was forgotten.
 *
 * **The sort map is checked against nothing but itself.** A sort field is a
 * *value* the client sends in the `sort` parameter, not a property of the DTO —
 * the DTO has exactly one `sort` property, and its value names a column. So the
 * sort map's keys are the sortable column names, and the only check that matters
 * on it is that the default sort is one of them, which the `defaultSort:
 * keyof typeof sort` shape enforces.
 */
export function defineQuerySpec<
  TDto extends object,
  TSort extends string = string,
>(spec: {
  readonly filters: FilterFieldMap<FilterKeys<TDto> & string>;
  readonly sort: SortFieldMap<TSort>;
  readonly defaultSort: TSort;
}): QuerySpec<FilterKeys<TDto> & string> {
  return spec;
}

/**
 * The sortable column names of a spec.
 *
 * **Read off the spec rather than restated**, so the two cannot drift.
 */
export type SortKeys<TSpec> = TSpec extends { sort: infer TSort }
  ? keyof TSort & string
  : never;
