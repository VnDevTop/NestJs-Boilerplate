# Search

One query language, reusable by every searchable entity.

`src/common/search/` holds a tokenizer, a parser, the tree they produce, a field
registry and three translators. **None of them knows an entity.** Adding search to
`customers`, `orders` or `invoices` is one field-map file and no new
infrastructure.

```text
search
├── ast.ts             the eight shapes a parsed query can take
├── tokenizer.ts       the words, and the escapes that make a colon literal
├── parser.ts          recursive descent, one method per precedence level
├── errors.ts          the errors, and the position in the query they point at
├── field-registry.ts  the fields an entity may be searched by
└── translators/
    ├── postgres.ts    the filter and the rank
    ├── in-memory.ts   the same questions, answered in JavaScript
    ├── facet.ts       the counts of the matching rows, per field
    └── mock.ts        for testing the caller rather than the translation
```

## What it is, and what it is not

It is a **language**: `email:ada AND role:admin`, `"ada lovelace"`,
`createdAt:[2026-01-01 TO 2026-12-31]`. The parser turns that into a tree,
and a translator turns the tree into something a database can answer.

It is **not** a query builder and **not** an ORM. The `common/query` layer is
those, and it is a different thing: a request becomes a _criteria_ there, and
the criteria is built from a route's declared filter set. Here the request is a
_sentence_, and the sentences it can contain are the language's.

## The field map

Every searchable entity has one file: a map from a field name to what that field
is.

```ts
export const USER_SEARCH_FIELDS = new SearchFieldRegistry(
  {
    email: {
      type: 'text',
      searchable: true,
      filterable: true,
      sortable: true,
      weight: 1,
      column: 'email',
    },
  },
  {
    defaultField: 'email',
    documentColumn: 'searchVector',
  },
);
```

### The types

**The type decides how a value is compared**, and it is why a translator can
refuse a value that could never match.

| Type      | A term is                       | A range is          | Example          |
| --------- | ------------------------------- | ------------------- | ---------------- |
| `text`    | a substring, case-insensitively | a string comparison | email, firstName |
| `keyword` | the whole value, exactly        | a string comparison | role, status     |
| `number`  | the number                      | a numeric range     | age, totalCents  |
| `date`    | the timestamp                   | a timestamp range   | createdAt        |
| `boolean` | the boolean                     | refused             | isActive         |
| `uuid`    | the identifier, exactly         | a string comparison | id               |

A `text` field is a substring match and a `keyword` is an equality, and the
difference is the difference between `ada` finding `ada@example.test` and `role:adm`
finding nothing.

### The three capabilities

**Three flags, and each one is a refusal as much as a permission.**

| Capability   | Allows                                    | Refuses                                                             |
| ------------ | ----------------------------------------- | ------------------------------------------------------------------- |
| `searchable` | a term, a phrase or a wildcard            | a term on a field that is not searchable — a password hash, for one |
| `filterable` | a range, an equality or an existence test | a range on a field that is not filterable                           |
| `sortable`   | being the sort                            | sorting by a field that is not sortable                             |

The refusals matter more than the permissions. A field that is not searchable is
refused rather than quietly matching nothing, because "no such user" and "you may
not search that field" look identical from the outside and mean opposite things.

**A field that is not sortable is refused too**, and the reason is not that
sorting it is unsafe: it is that the question it answers is the wrong one.
Sorting by a first name is legal SQL and useless in practice — the useful sort
is by the full name or by the address.

### The weight

**How much the field counts for, between 0 and 1.** It goes into the document,
so a match on the address outranks a match on the role.

The weight is a number and postgres has four letters, so a weight of 0.5 and one
of 0.6 both land in the same band. The bands are postgres's own: A for the
heaviest, then B, C and D.

## Registering an entity

**Five steps, and only the first two are the application.**

1. **Give the entity a document column.** A `tsvector` holding the searchable
   text of the row, with each field's weight baked in, and a GIN index over it.

   ```sql
   ALTER TABLE "users" ADD "searchVector" tsvector GENERATED ALWAYS AS (
     setweight(to_tsvector('simple', coalesce("email", '')), 'A') || ...
   ) STORED;
   CREATE INDEX "IDX_users_search_vector" ON "users" USING GIN ("searchVector");
   ```

   A **generated** column, not a trigger: a trigger is a thing that can miss a
   write, and a search index that is wrong is worse than no index, because it
   answers "no such user" for a user that exists.

2. **Write the field map.** The six facts per field, and the document column's
   name.

3. **Translate it into SQL.** `translateToFullText(tree, FIELDS, { alias })` gives
   a filter and a rank; `translateToFacet(tree, FIELDS, 'role', { table })` gives
   the counts.

4. **Add the route.** A body, a permission, and a service method that hands the
   two to the translator.

5. **Keep the three in step.** The expression that fills the document is
   written in the field map, in the entity and in the migration, and a spec
   compares the three. A weight that changed in one of them and not the others
   would make the ranking quietly wrong.

## A worked example: orders

An entity of a **different shape** — a uuid, money as an integer, a keyword and
a date — to show that the machinery does not assume a user.

```ts
export const ORDER_SEARCH_FIELDS = new SearchFieldRegistry(
  {
    id: {
      type: 'uuid',
      // Not searchable: a uuid is looked up, not searched for. It is compared
      // for equality, which is what `filterable` is for.
      searchable: false,
      filterable: true,
      sortable: true,
      weight: 0,
      column: 'id',
    },
    customerEmail: {
      type: 'text',
      searchable: true,
      filterable: true,
      sortable: true,
      weight: 1,
      column: 'customerEmail',
    },
    reference: {
      type: 'keyword',
      searchable: true,
      filterable: true,
      sortable: true,
      weight: 0.9,
      column: 'reference',
    },
    status: {
      type: 'keyword',
      searchable: true,
      filterable: true,
      sortable: true,
      weight: 0.5,
      column: 'status',
    },
    totalCents: {
      type: 'number',
      // Not searchable: a number is not a word, and `totalCents:100` is a
      // comparison rather than a match.
      searchable: false,
      filterable: true,
      sortable: true,
      weight: 0.2,
      column: 'totalCents',
    },
    placedAt: {
      type: 'date',
      searchable: false,
      filterable: true,
      sortable: true,
      weight: 0.3,
      column: 'placedAt',
    },
    notes: {
      type: 'text',
      searchable: true,
      filterable: true,
      // Not sortable: nobody sorts orders by their notes.
      sortable: false,
      weight: 0.1,
      column: 'notes',
    },
  },
  {
    defaultField: 'customerEmail',
    documentColumn: 'searchVector',
  },
);
```

The queries it answers, and what each one means:

| Query                                                     | Answers                                                          |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| `acme`                                                    | the orders whose customer address, reference or notes mention it |
| `reference:ORD-1001`                                      | exactly that order — a keyword is compared, not matched          |
| `status:paid`                                             | exactly that status                                              |
| `totalCents:[10000 TO 50000]`                             | the orders between a hundred and five hundred currency units     |
| `placedAt:[2026-01-01T00:00:00Z TO 2026-12-31T00:00:00Z]` | the orders placed in that year                                   |
| `id:8d7d34d4-8a52-4a7f-a92e-2d6d3ef9e631`                 | exactly that order                                               |

**The money is an integer, and the weight is on the address.** Two decisions
that are the entity's and not the layer's: the amounts are in cents so the
arithmetic is exact, and a customer address is worth more in a search than a
status is.

## A derived field

A field that is not a column of its own: a full name built from a first name
and a last name.

**The database computes it, so the application does not keep a second copy.**

```sql
ALTER TABLE "customers" ADD "fullName" text GENERATED ALWAYS AS (
  coalesce("firstName", '') || ' ' || coalesce("lastName", '')
) STORED;
```

and the map names the column:

```ts
name: {
  type: 'text',
  searchable: true,
  filterable: true,
  // Not sortable, for the same reason a first name is not sortable.
  sortable: false,
  weight: 0.6,
  column: 'fullName',
},
```

**`name:john` then works**, because the derived column is one of the map's
searchable fields and the document is built from those. A search for "john"
finds the customer whose full name contains it, and the full name is in the
document as well as the parts — so a customer called John Smith ranks above one
called John, which is usually what a search for a name means.

## The anti-patterns

**The things that look fine and are not.**

| Anti-pattern                                     | What happens                                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| A leading wildcard, `notes:*ever*`               | a full scan. There is no index for "contains", so every row is read                                                           |
| The wildcard `*` on its own                      | every row matches, and the answer is the table                                                                                |
| Sorting by a field that is not sortable          | refused, and the message says so                                                                                              |
| A facet over a text field                        | a group per distinct text, which is a group per row                                                                           |
| A fuzzy term                                     | refused by the SQL path. Postgres has no edit distance without an extension, and a trigram similarity is a different function |
| `email:ada` on a document that holds every field | it also matches a row whose _name_ contains "ada". One document per entity means one document to index                        |

**And the one that is not an anti-pattern but surprises people:** a term is
matched against the whole document, not against one column. That is what makes
one index answer a search over every field, and it is why a field-scoped term is
a _narrowing_ rather than an _exact_ filter.

## The tests

`search.test-kit.ts` holds the assertions every entity's search has to pass, so
an entity's spec is one call:

```ts
it('holds the search properties', () => {
  runSearchTestKit({ registry: USER_SEARCH_FIELDS });
});
```

**The kit asserts rather than registers**, so it ships in the build carrying no
dependency on a test framework, and its own spec breaks each of its properties on
purpose to show that the kit notices.

The kit checks four things: that the golden cases translate, that an undeclared
field is an error rather than a dropped clause, that the injection corpus never
reaches the SQL, and that the fragment is a **predicate** rather than a
statement — a translated fragment may contain a column name, a parameter, a
comparison and a boolean operator, and nothing else. A word outside that
vocabulary is a statement, and a semicolon is how a second statement begins.
