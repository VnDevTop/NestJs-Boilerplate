/**
 * The comparison a filter makes.
 *
 * **A closed set, and the request never chooses one.** The operator comes from
 * the entity's query spec, so a caller cannot ask for `~` or `~*` or a raw
 * fragment. A caller that could pick the operator would be choosing the SQL,
 * and every operator that is not in this list is one whose parameterisation
 * somebody would have to get right by hand.
 *
 * Each operator knows exactly one thing: how to turn a value into a bound
 * parameter and a SQL fragment. There is no general-purpose "expression"
 * operator, and that absence is the point — the whole mechanism is safe
 * because the set of shapes it can produce is finite and each one is written
 * out by hand in `apply-criteria.ts`.
 */
export const FILTER_OPERATORS = [
  /** `column = :value`. The default, and what most filters are. */
  'eq',
  /** `column != :value`. */
  'neq',
  /** `column > :value`. */
  'gt',
  /** `column >= :value`. */
  'gte',
  /** `column < :value`. */
  'lt',
  /** `column <= :value`. */
  'lte',
  /**
   * `column IN (:...value)`.
   *
   * The value is an array, and TypeORM expands it into one placeholder per
   * element. The array is a **parameter**, not an interpolated list, so the
   * elements are data all the way to postgres.
   */
  'in',
  /**
   * `column ILIKE :value`, with the wildcards added and the term escaped.
   *
   * Case-insensitive, because a search box that is case-sensitive is a search
   * box that misses results the user can see on screen. The wildcards and the
   * escaping are the operator's business, not the caller's: a caller who had to
   * write `%term%` would eventually write `%` on its own and search the whole
   * table.
   */
  'ilike',
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/**
 * Whether an operator can be used on a column at all.
 *
 * **The comparison operators and the pattern operators are different questions.**
 * `> 5` on a text column is not a comparison postgres can do, and `ILIKE` on a
 * boolean is not either. The spec says which operators a column accepts, so a
 * mismatch is a programming error caught by a test rather than a 500 from the
 * database at request time.
 */
export const NUMERIC_OPERATORS: readonly FilterOperator[] = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
];

export const STRING_OPERATORS: readonly FilterOperator[] = [
  'eq',
  'neq',
  'in',
  'ilike',
];

export const BOOLEAN_OPERATORS: readonly FilterOperator[] = ['eq', 'neq'];
