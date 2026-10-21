/**
 * The search language.
 *
 * One parser, one tree, and no entity anywhere in it. A query is text; the
 * tree is what a translator reads; which column a field means is the field
 * registry's business, and the registry is Phase 28.
 *
 * ```ts
 * import { parseSearchQuery } from '../common/search/index.js';
 *
 * const query = parseSearchQuery('email:ada AND role:admin');
 * ```
 */
export * from './ast.js';
export * from './errors.js';
export * from './field-registry.js';
export * from './parser.js';
export * from './tokenizer.js';
export * from './search.test-kit.js';
export * from './translators/full-text.js';
export * from './translators/in-memory.js';
export * from './translators/mock.js';
export * from './translators/postgres.js';
