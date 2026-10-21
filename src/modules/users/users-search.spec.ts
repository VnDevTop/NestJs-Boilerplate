import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getMetadataArgsStorage } from 'typeorm';

import { describe, expect, it } from 'vitest';

import { buildDocumentExpression } from '../../common/search/index.js';
import { User } from './entities/user.entity.js';
import { USER_SEARCH_FIELDS } from './users-search.js';

/**
 * The three places the document is written down.
 *
 * **The field map, the entity and the migration.** Each says what the document
 * holds, and each is a different file that somebody will edit. A weight that
 * changed in one of them and not the others would make the ranking quietly
 * wrong — a match on the address ranking below a match on the name — and
 * nothing would say so, because the search would still work and still return
 * the right rows.
 *
 * So this file compares them. The expression is the same shape in all three,
 * and the comparison is on the normalised text rather than on the exact
 * spacing, because the three of them were written for different reasons.
 */
const MIGRATION_FILE = join(
  process.cwd(),
  'src',
  'database',
  'migrations',
  '1792500000000-AddUserSearchVector.ts',
);

/** The text with the spacing taken out, so the three can be compared. */
const normalise = (text: string): string => text.replace(/\s+/g, '');

const migrationSource = readFileSync(MIGRATION_FILE, 'utf8');

/** The expression the entity declares for the generated column. */
function entityExpression(): string {
  const column = getMetadataArgsStorage().columns.find(
    (found) => found.target === User && found.propertyName === 'searchVector',
  );

  const expression = column?.options?.asExpression;

  if (typeof expression !== 'string') {
    throw new Error(
      'The User entity has no searchVector column with an expression, so the ' +
        'document it declares cannot be compared with the migration.',
    );
  }

  return expression;
}

describe('the document', () => {
  it('is the same expression in the field map and the entity', () => {
    expect(normalise(entityExpression())).toBe(
      normalise(buildDocumentExpression(USER_SEARCH_FIELDS)),
    );
  });

  it('is the same expression in the field map and the migration', () => {
    expect(normalise(migrationSource)).toContain(
      normalise(buildDocumentExpression(USER_SEARCH_FIELDS)),
    );
  });

  it('weights the address above the names and the role', () => {
    const expression = buildDocumentExpression(USER_SEARCH_FIELDS);

    // The letters are the bands postgres has, and they are the whole of the
    // ranking: A first, then B, then C.
    expect(expression).toContain(`"email", '')), 'A')`);
    expect(expression).toContain(`"firstName", '')), 'B')`);
    expect(expression).toContain(`"lastName", '')), 'B')`);
    expect(expression).toContain(`"role", '')), 'C')`);
  });

  it('holds the address, the names and the role, and nothing else', () => {
    const expression = buildDocumentExpression(USER_SEARCH_FIELDS);

    expect(expression).toContain('"email"');
    expect(expression).toContain('"firstName"');
    expect(expression).toContain('"lastName"');
    expect(expression).toContain('"role"');

    // The active flag and the creation date are filtered and sorted, never
    // searched: an account is either active or it is not, and a date is a range
    // rather than a word.
    expect(expression).not.toContain('"isActive"');
    expect(expression).not.toContain('"createdAt"');
  });

  it('is indexed with the type that can answer a word search', () => {
    // A b-tree over a document is useless for "which rows mention this".
    expect(migrationSource).toContain(
      'CREATE INDEX "IDX_users_search_vector" ON "users" USING GIN ("searchVector")',
    );
  });

  it('is declared on the entity with the type that can answer a word search', () => {
    const index = getMetadataArgsStorage().indices.find(
      (found) => found.name === 'IDX_users_search_vector',
    );

    // A b-tree over a document is useless for "which rows mention this", so
    // the type is not a detail of the declaration.
    expect(index?.type).toBe('gin');
  });

  it('is generated, so it cannot drift from the row', () => {
    // A column filled by a trigger is a column that can be wrong, and a search
    // index that is wrong answers "no such user" for a user that exists.
    expect(migrationSource).toContain('GENERATED ALWAYS AS');
    expect(entityExpression()).not.toBe('');
  });
});
