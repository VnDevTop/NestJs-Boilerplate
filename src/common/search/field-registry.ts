import { UnknownFieldError, UnsupportedFieldError } from './errors.js';

/**
 * What a field's values are.
 *
 * **The type decides how a value is compared**, and it is the reason the type
 * is in the registry rather than in each translator: a number compared with `=`
 * and a date compared with `=` are different SQL, and a keyword is not a text.
 *
 * - `text` — free text. Matched as a substring, case-insensitively.
 * - `keyword` — one value from a closed set. Matched exactly.
 * - `number` — a number. Compared numerically, and a value that is not one is
 *   refused rather than sent to postgres to fail on.
 * - `date` — a timestamp. Compared as a timestamp, and a value that is not one
 *   is refused.
 * - `boolean` — true or false.
 * - `uuid` — an identifier. Compared exactly, and a value that is not a uuid is
 *   refused.
 */
export type SearchFieldType =
  'text' | 'keyword' | 'number' | 'date' | 'boolean' | 'uuid';

/**
 * One field an entity can be searched by.
 *
 * **The six facts, and each of them earns its place.**
 *
 * - `type` — how the values are compared.
 * - `searchable` — whether the field can be matched with a term, a phrase or a
 *   wildcard. A password hash is not searchable.
 * - `filterable` — whether the field can be compared with a range or tested for
 *   existence. A blob of JSON is not filterable.
 * - `sortable` — whether the field can be sorted by. Declared here so the
 *   documentation can say what a field supports, and read by the query layer
 *   when it builds a sort.
 * - `weight` — how much the field counts for, between 0 and 1. **A ranking
 *   concern**: a boost and a weight change the order of the results, not which
 *   rows match.
 * - `column` — where the values live.
 */
export interface SearchField {
  readonly type: SearchFieldType;
  readonly searchable: boolean;
  readonly filterable: boolean;
  readonly sortable: boolean;
  /** Between 0 and 1, where 1 is the most important field. */
  readonly weight: number;
  /** The column the values live in. */
  readonly column: string;
}

export interface SearchFieldRegistryOptions {
  /**
   * The field a query that names no field is about.
   *
   * **Required, and it must be a declared field.** A default that is not
   * declared is a query that cannot be answered, and a default nobody set is
   * a query that silently means nothing.
   */
  readonly defaultField: string;
}

/**
 * A field name, as the client may write it.
 *
 * **The same rule the parser enforces**, so a name that reaches the registry
 * is a name the parser could have produced. A registry that accepted a name
 * the parser could not produce would be accepting a name no client can use.
 */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * A column name.
 *
 * **Checked, because the column is interpolated into SQL.** Everything else in
 * a search is a parameter, and a parameter cannot change the meaning of a
 * statement. A column is not a parameter — it is an identifier, and an
 * identifier cannot be bound — so the column is the one piece of a search that
 * becomes SQL text. Which means it has to be an identifier this application
 * wrote, and the check is what guarantees that: a registry that accepted
 * `"email" ; DROP TABLE users` would be a registry that had handed a client
 * the database.
 *
 * The allow-list is the boundary. A field name is the client's input and never
 * reaches SQL; a column is the application's and always does.
 */
const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The fields one entity can be searched by.
 *
 * **The registry is the allow-list, and it is the injection boundary.** A field
 * name in a query is the client's input, and the only way it can become SQL is
 * by being looked up here first. A name that is not declared is an
 * `UnknownFieldError` that lists the ones that are — never a field silently
 * dropped, because a dropped field is a filter the client believes is applied
 * and is not.
 */
export class SearchFieldRegistry {
  private readonly fields: Readonly<Record<string, SearchField>>;

  /** The field a query that names no field is about. */
  readonly defaultField: string;

  constructor(
    fields: Readonly<Record<string, SearchField>>,
    options: SearchFieldRegistryOptions,
  ) {
    this.fields = Object.freeze({ ...fields });
    this.defaultField = options.defaultField;

    this.validate();
  }

  /**
   * The descriptor for a field.
   *
   * **Throws rather than returning nothing.** A caller that asked for a field
   * and got `undefined` would have to decide what to do about it, and every
   * decision it could make is wrong: skipping the clause answers a different
   * question, and matching everything is worse.
   */
  field(name: string): SearchField {
    const field = this.fields[name];

    if (field === undefined) {
      throw new UnknownFieldError(name, this.names());
    }

    return field;
  }

  /** True for a field this registry has. */
  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.fields, name);
  }

  /** The field names, in the order they were declared. */
  names(): string[] {
    return Object.keys(this.fields);
  }

  /** The columns this registry may put into SQL. */
  columns(): string[] {
    return Object.values(this.fields).map((field) => field.column);
  }

  /**
   * The field for a name, or the default when the name is absent.
   *
   * **The default is resolved here rather than in each translator**, so a
   * translator that forgot to would fail one test rather than one entity's
   * search.
   */
  resolve(name: string | null): SearchField {
    if (name === null) {
      return this.field(this.defaultField);
    }

    return this.field(name);
  }

  /**
   * A field that may be matched with a term, a phrase or a wildcard.
   *
   * **The check is here so that every translator gets it.** A field that is not
   * searchable is not searchable whatever the backend does with it, and the
   * client is told so rather than being handed a query that quietly matches
   * nothing.
   */
  searchableField(name: string | null): SearchField {
    const field = this.resolve(name);

    if (!field.searchable) {
      throw new UnsupportedFieldError(name ?? this.defaultField, 'searchable');
    }

    return field;
  }

  /** A field that may be compared with a range or tested for existence. */
  filterableField(name: string | null): SearchField {
    const field = this.resolve(name);

    if (!field.filterable) {
      throw new UnsupportedFieldError(name ?? this.defaultField, 'filterable');
    }

    return field;
  }

  /**
   * The checks a registry has to pass before it is used.
   *
   * **These are programming errors, not client errors**, and they are found
   * here rather than in the first search that trips over them: a field map is
   * written once and read by every query, so a typo in it would otherwise be
   * discovered by whichever client happened to search that field first.
   */
  private validate(): void {
    for (const [name, field] of Object.entries(this.fields)) {
      if (!FIELD_NAME.test(name)) {
        throw new Error(
          `"${name}" is not a field name. A field is an identifier: a letter, ` +
            'then letters, digits and underscores.',
        );
      }

      if (!COLUMN_NAME.test(field.column)) {
        // The column is interpolated into SQL, so this is the check that keeps a
        // field map from being able to hand a client the database.
        throw new Error(
          `"${field.column}" is not a column name. A column is interpolated ` +
            'into SQL, so it has to be an identifier.',
        );
      }

      if (field.weight < 0 || field.weight > 1) {
        throw new Error(
          `The weight of "${name}" is ${field.weight}. A weight is between 0 ` +
            'and 1, where 1 is the most important field.',
        );
      }
    }

    if (!this.has(this.defaultField)) {
      throw new Error(
        `The default field "${this.defaultField}" is not one of the declared ` +
          `fields: ${this.names().join(', ')}.`,
      );
    }
  }
}
