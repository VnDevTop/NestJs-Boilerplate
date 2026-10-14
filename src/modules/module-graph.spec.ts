import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * No value-import cycles in `src`.
 *
 * This exists because of a failure that reads as a wiring bug and is not one.
 * `queue.module.ts` reached the retention module through `maintenance/index.js`,
 * which also re-exports `MaintenanceSchedulerModule`, which imports
 * `QueueModule` back. Under `node dist/main` the cycle resolved — the evaluation
 * order happened to suit it. Under vitest it did not, and the e2e suite died at
 * boot with:
 *
 * ```text
 * Nest cannot create the QueueModule instance.
 * The module at index [2] of the QueueModule "imports" array is undefined.
 * ```
 *
 * Which reads like a missing provider and is actually an import cycle, and which
 * passes every unit test in the repository because no unit test builds the
 * application. Two things follow, and both are asserted here.
 *
 * **Type-only cycles are allowed.** `import type` is erased before the module
 * graph exists, so `mail.templates.ts` importing the `MailTemplate` interface
 * from the registry that imports it back is not a cycle. Counting those would
 * produce an ignore list nobody maintains.
 *
 * **Reaching a module through a barrel is the thing that made this possible.**
 * `import { X } from './y/index.js'` evaluates every file the barrel re-exports,
 * including the ones that import back. The second test checks the specific
 * mistake; the first checks the general rule, which is what stops it coming back
 * somewhere else.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Node {
  file: string;
  /** Files reached by an import that survives compilation. */
  valueImports: string[];
  /** Files reached through a barrel, which evaluates the whole folder. */
  barrelImports: string[];
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

/**
 * Every value import in a file, resolved.
 *
 * Multi-line import clauses are matched whole, because deciding this by line
 * would call `import {\n  TypeOnlyThing,\n} from './x.js'` a value import and
 * report two type-only cycles as real ones.
 */
function importsIn(file: string, kind: 'value' | 'barrel'): string[] {
  const source = readFileSync(file, 'utf8');
  const found: string[] = [];

  const statements = source.matchAll(
    /(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)\s*from\s*'(\.[^']+)'/g,
  );

  for (const [, clause, specifier] of statements) {
    const target = resolveRelative(file, specifier);

    if (target === null) {
      continue;
    }

    if (kind === 'barrel' && !isBarrel(file, target)) {
      continue;
    }

    if (kind === 'value' && isTypeOnly(clause)) {
      continue;
    }

    found.push(target);
  }

  return found;
}

/**
 * True for an import the compiler erases.
 *
 * Both `import type { X }` and `import { type X }` are erased; a clause that
 * mixes the two — `import { type X, Y }` — is not, because `Y` is a value and
 * the edge is real.
 */
function isTypeOnly(clause: string): boolean {
  const trimmed = clause.trim();

  if (/^type\b/.test(trimmed)) {
    return true;
  }

  const braces = trimmed.match(/\{([\s\S]*)\}/);

  if (!braces) {
    return false;
  }

  const specifiers = braces[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  return (
    specifiers.length > 0 && specifiers.every((part) => /^type\s/.test(part))
  );
}

/** `.js` in the specifier, `.ts` on disk, or the folder's `index.ts`. */
function resolveRelative(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier.replace(/\.js$/, ''));
  const candidates = [`${base}.ts`, join(base, 'index.ts')];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const isBarrel = (from: string, target: string): boolean =>
  target.endsWith('/index.ts') && dirname(target) !== dirname(from);

const graph: Node[] = sourceFiles(SRC).map((file) => ({
  file,
  valueImports: importsIn(file, 'value'),
  barrelImports: importsIn(file, 'barrel'),
}));

/** Tarjan, iterative so a deep graph cannot blow the stack on a bad day. */
function cyclesIn(nodes: Node[]): string[][] {
  const byFile = new Map(nodes.map((node) => [node.file, node]));
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  let counter = 0;

  for (const start of byFile.keys()) {
    if (index.has(start)) {
      continue;
    }

    const work: { file: string; edge: number }[] = [{ file: start, edge: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const edges = byFile.get(frame.file)?.valueImports ?? [];

      if (frame.edge < edges.length) {
        const next = edges[frame.edge];
        frame.edge += 1;

        if (!byFile.has(next)) {
          continue;
        }

        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ file: next, edge: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.file, Math.min(low.get(frame.file)!, index.get(next)!));
        }

        continue;
      }

      work.pop();

      if (low.get(frame.file) === index.get(frame.file)) {
        const component: string[] = [];
        let member: string;

        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.file);

        if (component.length > 1) {
          found.push(component.sort());
        }
      }

      const parent = work[work.length - 1];

      if (parent) {
        low.set(
          parent.file,
          Math.min(low.get(parent.file)!, low.get(frame.file)!),
        );
      }
    }
  }

  return found;
}

const relative = (file: string): string => file.slice(SRC.length + 1);

describe('the module graph', () => {
  it('has no value-import cycle', () => {
    const cycles = cyclesIn(graph).map((cycle) => cycle.map(relative));

    // A cycle means two modules evaluate in an order the loader chooses. One
    // order happens to work under `node dist/main` and the other does not, and
    // the failure names a provider rather than an import.
    expect(cycles).toEqual([]);
  });

  it('reaches a module through its file, not through a barrel', () => {
    const through = graph.flatMap((node) =>
      node.barrelImports
        // `../mail/index.js` is fine; what is not fine is a barrel that
        // re-exports a module importing back, and the rule is cheaper to state
        // as "no barrel" than as an exception list per barrel.
        .filter((target) => target.endsWith('module.ts'))
        .map((target) => `${relative(node.file)} -> ${relative(target)}`),
    );

    expect(through).toEqual([]);
  });
});
