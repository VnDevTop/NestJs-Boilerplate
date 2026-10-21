/**
 * The shape a parsed search query takes.
 *
 * **The parser knows no entity.** A field is a name in the tree and nothing
 * more: which column it lands on, whether it can be searched at all and what it
 * weighs are the field registry's business, and the registry is Phase 28. That
 * split is the whole point of the phase — adding search to `customers`,
 * `orders` or `invoices` is one field-map file and no new infrastructure — and
 * it is why nothing here mentions a column, a table or a weight.
 *
 * ## Why a binary tree and not `must`/`should`/`mustNot`
 *
 * A flat structure — a list of required clauses, a list of optional ones and a
 * list of prohibited ones — is the shape Elasticsearch's JSON query DSL uses, and
 * it carries a rule that is easy to get wrong: a `should` clause is *optional*
 * only when there is no `must`. `a AND (b OR c)` means `a AND (b OR c)`, not
 * `a AND b`, and a translator that flattens the two answers a different
 * question from the one asked.
 *
 * A binary tree makes the grouping explicit in the shape itself. Every node is
 * a self-contained boolean over two clauses, and a translator emits a
 * parenthesised expression per node — there is no context to carry and nothing
 * to get wrong.
 *
 * ## Why `field: null` rather than a default field name
 *
 * A query that does not name a field is a query against *the* default field,
 * and the default field is a property of the entity being searched. The parser
 * cannot know it, so it says "the default field" and lets the registry resolve
 * it. A parser that hard-coded a field name would be a parser that knows about
 * an entity, which is the thing this phase is careful not to do.
 */

/** Matches every row. The empty query, and `*:*`. */
export interface MatchAllQuery {
  readonly type: 'matchAll';
}

/**
 * A term against one field.
 *
 * `fuzzy` is the edit distance, and it is here rather than in its own node type
 * because a fuzzy term is a term with a distance attached — the same question
 * with a tolerance, not a different question.
 */
export interface FieldQuery {
  readonly type: 'field';
  /** The field, or null for the entity's default field. */
  readonly field: string | null;
  /** The term, unescaped and un-normalised. */
  readonly value: string;
  /** The edit distance, when the term was written `term~` or `term~2`. */
  readonly fuzzy?: number;
}

/** A quoted sequence of terms that have to appear together, in order. */
export interface PhraseQuery {
  readonly type: 'phrase';
  readonly field: string | null;
  /** The terms, in the order they were written. */
  readonly terms: readonly string[];
}

/**
 * A pattern: `wild*`, `f?y`.
 *
 * The pattern keeps its wildcards. What a `*` means is the translator's
 * business — a Postgres `tsquery` and an OpenSearch query do not agree about it
 * — and a parser that resolved the wildcards into a regular expression would
 * have made the translator's job harder rather than easier.
 */
export interface WildcardQuery {
  readonly type: 'wildcard';
  readonly field: string | null;
  /** The pattern, wildcards intact. */
  readonly pattern: string;
}

/** `field:*` — the field has a value. */
export interface ExistsQuery {
  readonly type: 'exists';
  readonly field: string;
}

/**
 * A range over one field.
 *
 * The bounds are the text the user wrote, not numbers. A range is over a
 * date, a number or a keyword, and which one it is depends on the field — so
 * the parser does not convert, and the translator binds the text as a
 * parameter of the column's own type.
 */
export interface RangeQuery {
  readonly type: 'range';
  readonly field: string | null;
  /** The lower bound, or null for an open one. */
  readonly lower: string | null;
  /** The upper bound, or null for an open one. */
  readonly upper: string | null;
  /** False for `{a TO b}`, true for `[a TO b]`. */
  readonly inclusiveLower: boolean;
  /** False for `{a TO b}`, true for `[a TO b]`. */
  readonly inclusiveUpper: boolean;
}

/** A clause with a boost. `term^3` scores three times as heavily. */
export interface BoostQuery {
  readonly type: 'boost';
  readonly query: SearchQuery;
  /** The multiplier. Always greater than zero. */
  readonly boost: number;
}

/** Two clauses combined. */
export type BooleanQuery =
  | {
      readonly type: 'boolean';
      readonly operator: 'and' | 'or';
      readonly left: SearchQuery;
      readonly right: SearchQuery;
    }
  | {
      readonly type: 'boolean';
      readonly operator: 'not';
      readonly operand: SearchQuery;
    };

/** Every shape a parsed query can take. */
export type SearchQuery =
  | MatchAllQuery
  | FieldQuery
  | PhraseQuery
  | WildcardQuery
  | ExistsQuery
  | RangeQuery
  | BoostQuery
  | BooleanQuery;

/** The node types, as a value — for a switch, a map or an exhaustiveness check. */
export const SEARCH_QUERY_TYPES = [
  'matchAll',
  'field',
  'phrase',
  'wildcard',
  'exists',
  'range',
  'boost',
  'boolean',
] as const;

export type SearchQueryType = (typeof SEARCH_QUERY_TYPES)[number];

/**
 * True for a node that matches on a field's value.
 *
 * The translators need this distinction: a clause with a field is a filter on
 * that column, and a clause without one is a query against the entity's default
 * field — which is a *different* column, and one the registry names.
 */
export const isFieldClause = (
  query: SearchQuery,
): query is
  FieldQuery | PhraseQuery | WildcardQuery | ExistsQuery | RangeQuery =>
  query.type === 'field' ||
  query.type === 'phrase' ||
  query.type === 'wildcard' ||
  query.type === 'exists' ||
  query.type === 'range';
