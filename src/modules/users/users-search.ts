import { SearchFieldRegistry } from '../../common/search/index.js';

/**
 * The fields a user can be searched by.
 *
 * **The six the plan names, and a weight for each.** The weight is how much
 * the field counts for in the rank, and it is a number between 0 and 1 — the
 * bands postgres has are A, B, C and D, and a weight of 0.5 and one of 0.6 both
 * land in B.
 *
 * **The weights are chosen, not defaulted.** The address is the field a person
 * identifies an account by, so it is the heaviest. A name is nearly as
 * identifying. The role is a word about the account rather than a name, and it
 * is the lightest of the three that are searched. The two that are only
 * filtered — the active flag and the creation date — are not in the document at
 * all, and their weight is zero because nothing ranks them.
 *
 * **The document is `searchVector`, and the expression that fills it is built
 * from this map.** A spec compares the two, so the weights here and the
 * `setweight` letters in the migration cannot drift apart — which is the
 * failure that would make a match on the address rank below a match on the
 * name.
 */
export const USER_SEARCH_FIELDS = new SearchFieldRegistry(
  {
    email: {
      type: 'text',
      searchable: true,
      filterable: true,
      sortable: true,
      // The heaviest field: the address is what a person identifies an account
      // by, and a match on it is the one they meant.
      weight: 1,
      column: 'email',
    },

    firstName: {
      type: 'text',
      searchable: true,
      filterable: true,
      // Not sortable, and for the same reason the listing route does not sort
      // by a name either: it is legal SQL and useless in practice — the
      // question it answers is "do you mean the full name?".
      sortable: false,
      // Nearly as identifying as the address, and lighter than it.
      weight: 0.6,
      column: 'firstName',
    },

    lastName: {
      type: 'text',
      searchable: true,
      filterable: true,
      // Not sortable, for the same reason as the first name.
      sortable: false,
      // The same as the first name, because a name is a name.
      weight: 0.6,
      column: 'lastName',
    },

    role: {
      type: 'keyword',
      searchable: true,
      filterable: true,
      sortable: true,
      // A word about the account rather than a name for it. Searchable — "the
      // admins" is a real question — and lighter than a name.
      weight: 0.3,
      column: 'role',
    },

    isActive: {
      type: 'boolean',
      searchable: false,
      filterable: true,
      sortable: true,
      // Filtered, never searched, and never ranked: an account is either active
      // or it is not, and no amount of it in the document would mean anything.
      weight: 0,
      column: 'isActive',
    },

    createdAt: {
      type: 'date',
      searchable: false,
      filterable: true,
      sortable: true,
      // Filtered and sorted, never searched: a date is a range, not a word.
      weight: 0,
      column: 'createdAt',
    },
  },
  {
    defaultField: 'email',
    // The column the migration creates: the weighted document every text field
    // is folded into.
    documentColumn: 'searchVector',
  },
);
