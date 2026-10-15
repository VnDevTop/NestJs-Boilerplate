import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TemplateName } from './template.registry.js';

/**
 * The shipped templates, read off disk.
 *
 * ## Why a directory of `.hbs` files and not a generated TypeScript module
 *
 * The plain functions this replaces were reviewable in a diff. That is a real
 * property and the phase gives it up for editability — but only for the *copy in the
 * database*. The file stays the definition, so it has to stay something a reviewer
 * can read, and a generated file full of escaped string literals is the worst of
 * both: unreadable in a diff and unrunnable without a build step.
 *
 * `nest build` copies this directory because `nest-cli.json` lists it under
 * `assets`, so the files are next to the compiled JavaScript in `dist` and the same
 * lookup works in both. `spec.source` resolves relative to this module rather than to
 * `process.cwd()` for the same reason the rest of the repository uses `.js`
 * specifiers: a process started from another directory still finds its templates.
 */

/** One template's three parts, as authored. */
export interface TemplateSource {
  subject: string;
  text: string;
  html: string;
}

/**
 * Resolves the `hbs/` directory next to this module.
 *
 * `import.meta.url` rather than `__dirname`, because the module is ESM and has no
 * `__dirname`; the `.js` here is the compiled file's own name, which keeps this
 * identical under vitest (running the `.ts`) and under `node dist/main` (running the
 * `.js`).
 */
const HBS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'hbs');

/**
 * Reads one part of one template.
 *
 * Throws rather than returning empty. A template file that has been renamed or
 * deleted is a packaging fault, and an empty subject produces a mail whose subject
 * line is the app name — which is the kind of thing that ships and is noticed by a
 * customer rather than by a deploy.
 */
function readPart(
  name: TemplateName,
  part: 'subject' | 'text' | 'html',
): string {
  return readFileSync(resolve(HBS_DIR, `${name}.${part}.hbs`), 'utf8').trim();
}

/**
 * The shipped source for a template, or null when there is no file for it.
 *
 * Null rather than a throw, because the seeder and the admin preview both need to
 * ask "is this template backed by a file" without treating the answer as an error,
 * and a name with no file is legitimate for a template that only ever exists in the
 * database.
 */
export function loadShippedTemplate(name: TemplateName): TemplateSource | null {
  const parts: TemplateSource = { subject: '', text: '', html: '' };

  for (const part of ['subject', 'text', 'html'] as const) {
    try {
      parts[part] = readPart(name, part);
    } catch {
      return null;
    }
  }

  return parts;
}
