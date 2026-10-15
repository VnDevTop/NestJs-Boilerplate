import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Every field of every `@Body()` type carries a validation decorator.
 *
 * The global pipe runs with `whitelist: true`, and `whitelist` means what it says:
 * a property that no class-validator decorator names is **removed from the object**
 * before the controller sees it. `@ApiProperty` is documentation — it reaches the
 * Swagger page and nothing else — so a DTO written with only `@ApiProperty` is a
 * DTO whose body arrives empty.
 *
 * That is not a theoretical hole. Two routes shipped that way:
 *
 * - `PUT /admin/roles/:role/permissions` answered 400 for every call, because
 *   `permissions` was stripped and the controller checks for a list.
 * - `PATCH /notifications/preferences` had nothing to write, because all three
 *   fields of the pair and the list itself were stripped.
 *
 * Both were found by the end-to-end suite, and both are invisible to every unit
 * test, because a unit test calls the controller method with an object it built
 * itself — it never runs the pipe.
 *
 * So the rule is checked here instead: for each type a controller binds with
 * `@Body()`, every declared property must carry at least one validator. Adding a
 * documented field without validating it now fails the unit job rather than a
 * deployment.
 */
// This file sits in `src/common/pipes`, so the source root is two levels up.
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** `@(Is…|Array…|Validate…|Transform|Type|Min|Max|Length|Matches)`. */
const VALIDATOR =
  /^@(Is\w+|Array\w+|Validate\w+|Min|Max|Length|Matches|Allow|Type)\b/;

interface Property {
  name: string;
  /** Lines of decorators immediately above the declaration. */
  decorators: string[];
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      found.push(path);
    }
  }

  return found;
}

function controllerFiles(): string[] {
  return sourceFiles(SRC).filter((file) => file.endsWith('.controller.ts'));
}

/** The type names every `@Body()` parameter is declared with. */
function bodyTypes(): Set<string> {
  const types = new Set<string>();

  for (const file of controllerFiles()) {
    const source = readFileSync(file, 'utf8');

    for (const match of source.matchAll(
      /@Body\([^)]*\)\s*\w+!?:\s*([A-Z]\w*Dto)\b/g,
    )) {
      types.add(match[1]);
    }
  }

  return types;
}

function dtoFileFor(name: string): string | null {
  for (const file of sourceFiles(SRC)) {
    if (
      file.endsWith('.dto.ts') &&
      new RegExp(`class ${name}\\b`).test(readFileSync(file, 'utf8'))
    ) {
      return file;
    }
  }

  return null;
}

const countChar = (line: string, char: string): number =>
  line.split(char).length - 1;

/** The properties of one DTO class, with the decorators stacked above each. */
function propertiesOf(name: string): Property[] {
  const file = dtoFileFor(name);

  if (file === null) {
    return [];
  }

  const source = readFileSync(file, 'utf8');
  const body = source.match(
    new RegExp(`class ${name}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`),
  )?.[1];

  if (body === undefined) {
    return [];
  }

  const properties: Property[] = [];
  let decorators: string[] = [];
  // Depth of parentheses, so `example:` and `description:` inside a
  // multi-line `@ApiProperty({...})` are not mistaken for property declarations.
  let depth = 0;

  for (const raw of body.split('\n')) {
    const line = raw.trim();

    const opensArgumentList =
      depth === 0 && line.startsWith('@') && line.includes('(');

    depth += countChar(line, '(') - countChar(line, ')');

    // Recorded before the depth check, because a decorator that carries an argument
    // list is a decorator first:
    //
    // ```ts
    // @Matches(LANGUAGE_TAG, {     <- opens the list, and is the decorator
    //   message: '…',
    // })
    // locale?: string;
    // ```
    //
    // `depth > 0` on that first line, so the check below skipped it and the field
    // came back with no decorators at all. The guard then reported a correctly
    // decorated field as unvalidated — a false positive in the direction that teaches
    // the next reader to ignore the guard, which is worse than the false negative it
    // was built to prevent.
    if (opensArgumentList) {
      decorators.push(line);
      continue;
    }

    if (depth > 0) {
      // Inside a decorator's argument list. `example:` and `message:` are arguments
      // here, never property declarations.
      continue;
    }

    if (line.startsWith('@')) {
      decorators.push(line);
      continue;
    }

    const declaration = line.match(/^([a-zA-Z_]\w*)[!?]?:/);

    if (declaration) {
      properties.push({ name: declaration[1], decorators });
      decorators = [];
      continue;
    }

    // A blank line ends a decorator block.
    //
    // A `}` does too, but only when it *closes a class or method*, not when it
    // closes a decorator's argument list. `})` at depth 0 after `@Matches(LANGUAGE_TAG, {`
    // closes that decorator, and clearing there discarded every decorator stacked
    // above it — which is how `UpdateMailTemplateDto.locale` came back with none and
    // the guard reported a correctly decorated field as unvalidated.
    if (line === '') {
      decorators = [];
    }
  }

  return properties;
}

describe('request DTOs', () => {
  const types = bodyTypes();

  it('finds the body types to check', () => {
    // A scanner that finds nothing would pass every assertion below vacuously,
    // which is the same failure mode as a guard test over an empty list.
    expect(types.size).toBeGreaterThan(5);
  });

  for (const name of [...types].sort()) {
    it(`${name} validates every field it accepts`, () => {
      const properties = propertiesOf(name);

      expect(
        properties.length,
        `${name} was found but has no properties`,
      ).toBeGreaterThan(0);

      const unvalidated = properties
        .filter(
          (property) =>
            !property.decorators.some((decorator) => VALIDATOR.test(decorator)),
        )
        .map((property) => property.name);

      expect(
        unvalidated,
        `${name} documents ${unvalidated.join(', ')} with @ApiProperty only. ` +
          'The global pipe strips a property no class-validator decorator names, ' +
          'so the controller receives undefined — and Swagger keeps advertising the ' +
          'field as if it worked.',
      ).toEqual([]);
    });
  }
});
