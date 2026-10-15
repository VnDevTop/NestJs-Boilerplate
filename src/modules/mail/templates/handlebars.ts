import Handlebars from 'handlebars';

/**
 * The template engine, and the only place a stored template is turned into markup.
 *
 * ## What is being given up
 *
 * Before Phase 22 a template was a plain function in `mail.templates.ts`, so it was
 * reviewed in a diff and had no engine in the dependency tree. An operator could not
 * change a welcome email without a deploy. Both of those are real, and the phase
 * trades them for editability deliberately — see `PLAN.md` and
 * `src/modules/mail/README.md` for the argument.
 *
 * What is not given up is that a template still cannot reach anything it was not
 * given. The environment below is a private `Handlebars.create()` instance rather
 * than the global one, because the global registry is process-wide and mutable: a
 * helper registered anywhere would apply here too, and a template that could call an
 * unknown helper is a template whose behaviour depends on load order.
 *
 * ## The escaping rule
 *
 * Handlebars escapes `{{ }}` by default and does **not** escape `{{{ }}}`. A
 * template is rendered into a mail client, and `{{user.firstName}}` reaches it as
 * user input — so a triple-brace on a user-controlled field is script execution in
 * the reader's client. `assertSafeToRender` is what makes that impossible rather
 * than discouraged.
 *
 * It is applied to stored templates only. A `.hbs` file in this repository is trusted
 * because it went through review, exactly as the plain functions were; the ones in
 * the database did not.
 */
const environment = Handlebars.create();

/**
 * Every helper this application offers a template.
 *
 * Declared as data rather than as a list of `registerHelper` calls, because
 * `knownHelpersOnly: true` is what makes an unknown helper a compile error instead of
 * a silently-empty string — and it needs the set of known names to compare against.
 * A helper registered but not listed here is one no template can call, which is the
 * failure mode a reader would spend an afternoon on.
 *
 * Adding one here is a deliberate act: it is the whole trust surface of the engine,
 * because every helper is callable from a stored template.
 */
const HELPERS = {
  /**
   * Tells a missing count from a count of zero.
   *
   * `{{#if failures}}` cannot express this template's requirement. `failures` is
   * `number | null`, and the count is only known while redis still remembers it. The
   * sentence has to fall back to "too many" when the number is gone — guessing would
   * put a false number into an email about somebody's account — and `0` is falsy, so
   * the block helper cannot tell "no count" from "a count of zero".
   *
   * Used as a subexpression: `{{#if (isNull failures)}}`.
   */
  isNull: (value: unknown): boolean => value === null || value === undefined,

  /**
   * A primary call-to-action button, plus the bare url.
   *
   * Returns the anchor and its surrounding markup rather than a bare url, so a stored
   * template cannot produce a link that is only a link — a mail whose only call to
   * action is a raw url is the shape a phisher sends, and the reason this mail's
   * buttons are buttons.
   *
   * The url is escaped on the way in, which is what makes it safe to hand a
   * `{{verificationUrl}}` straight to this helper without a second escape that would
   * double-encode the `&` in a query string.
   */
  actionLink: (url: unknown, label: unknown): Handlebars.SafeString =>
    new Handlebars.SafeString(
      actionLinkHtml(String(url ?? ''), String(label ?? '')),
    ),

  /**
   * Splits an operator alert's body into its non-empty lines, for the html part.
   *
   * A notification body is a newline-separated list rendered by the event that raised
   * it, and a mail that shows it as one paragraph loses the fact that it was a list.
   * Handlebars has no split, so this is the helper standing in for one.
   *
   * Empty lines are dropped rather than rendered as a bullet with nothing beside it,
   * because a trailing newline in an event's body is not a message.
   */
  bodyLines: (body: unknown): string[] =>
    String(body ?? '')
      .split('\n')
      .filter((line) => line !== ''),

  /**
   * The same split for the text part, keeping blank lines.
   *
   * A blank line in the text half is paragraph spacing, which is the whole reason the
   * text part is not a stripped copy of the html: a client that shows no formatting
   * still has to be able to read it. The html half drops blanks because there the gap
   * is a row that would render as an empty bullet.
   */
  bodyLinesText: (body: unknown): string[] =>
    String(body ?? '')
      .split('\n')
      .map((line) => (line === '' ? '' : `\u2022 ${line}`)),
};

/**
 * The names handlebars is told about, which is the entire callable surface of a
 * stored template.
 *
 * A map rather than an array because that is what `knownHelpers` takes, and the
 * values are deliberately empty: handlebars only asks whether a name is present, and
 * a map whose values claimed to be implementations would be a second place to look
 * when a helper misbehaves.
 */
export const TEMPLATE_HELPERS: Record<string, true> = Object.fromEntries(
  Object.keys(HELPERS).map((name) => [name, true]),
);

for (const [name, fn] of Object.entries(HELPERS)) {
  environment.registerHelper(name, fn);
}

/**
 * The html for an action link. Kept beside the helper so the markup lives in one
 * place and the helper is only the binding.
 *
 * ## The url is attribute-escaped, not html-escaped
 *
 * `Handlebars.escapeExpression` is the html escaper and it encodes `=` as `&#x3D;`,
 * along with backtick and every other character that can start an attribute value in
 * an unquoted one. Applied to a url in an `href` that is not merely ugly — it is a
 * **broken link**, because the entity is what reaches the mail client and the token
 * in it no longer matches what the server issued.
 *
 * That was caught by a test asserting the rendered href and reading `token&#x3D;`
 * back, which is what a verification link that cannot verify looks like in a diff.
 *
 * The five characters below are the ones that matter in a quoted attribute value:
 * the quote itself, both angle brackets, and the ampersand that starts an entity.
 * Everything else in a url is passed through, which is the point — the characters
 * that make a url a url have to survive.
 *
 * The label uses the full html escaper, because a label is text rather than a url and
 * has no legitimate `<`, `>` or backtick in it.
 */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function actionLinkHtml(url: string, label: string): string {
  const safeUrl = escapeAttribute(url);
  const safeLabel = Handlebars.escapeExpression(label);

  return `<p style="margin:24px 0;"><a href="${safeUrl}" style="display:inline-block;padding:12px 20px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-size:15px;">${safeLabel}</a></p>
<p style="margin:0;font-size:13px;color:#52606d;word-break:break-all;">Or paste this into your browser:<br>${safeUrl}</p>`;
}

/** The plain-text half of the same link, for the text part. */
function actionLinkText(url: string, label: string): string {
  return `${label}: ${url}`;
}

/**
 * The triple-brace sequence, in every spacing handlebars accepts.
 *
 * `{{{x}}}`, `{ { { x } } }` and `{{ {x} }}` all compile to the same thing, so a
 * check for the literal `{{{` would reject the common spelling and pass the other
 * two. What is rejected is the *meaning*: an unescaped expression. Whitespace is
 * collapsed first so the check cannot be defeated by splitting it across lines.
 */
const UNESCAPED_EXPRESSION = /\{\{\s*\{[\s\S]*?\}\s*\}\}/;

/**
 * Refuses a stored template that opts out of escaping.
 *
 * Throws rather than sanitising: a template that wanted raw interpolation and did
 * not get it is a template whose author will find out immediately and fix, whereas a
 * silently-stripped `{{{` renders a literal `{` into somebody's welcome email and
 * is found weeks later by a user.
 *
 * @throws when the template contains a triple-brace expression
 */
export function assertSafeToRender(source: string, label: string): void {
  if (UNESCAPED_EXPRESSION.test(source.replace(/\s+/g, ' '))) {
    throw new Error(
      `The ${label} template contains a triple-brace expression ({{{ }}}). ` +
        'Stored templates may only use {{ }}, which escapes the value it ' +
        'interpolates. A raw expression would put unescaped user input into a ' +
        'mail client.',
    );
  }
}

/**
 * Compiles one part of a template.
 *
 * ## The two checks, and when each one fires
 *
 * `knownHelpersOnly` and `strict` are both real, but neither refuses an unknown
 * helper at **compile** time — handlebars defers both to the first render. That is
 * verified against the installed package rather than assumed, because the difference
 * decides where a bad template is found:
 *
 * - An unknown **helper** throws when the template renders. `save` compiles before
 *   writing but does not render, so a stored template naming a helper that does not
 *   exist is written and then fails on every send. `assertSafeToRender` below is
 *   what closes that window.
 * - A missing **value** throws at render too, for the same reason.
 *
 * The `nope` case in `handlebars.spec.ts` is asserted at render for the same reason:
 * asserting it at compile would be asserting a behaviour this version does not have.
 */
export function compilePart(
  source: string,
  label: string,
): Handlebars.TemplateDelegate {
  try {
    return environment.compile(source, {
      knownHelpers: TEMPLATE_HELPERS,
      knownHelpersOnly: true,
      strict: true,
      noEscape: false,
    });
  } catch (error) {
    throw new Error(
      `The ${label} template does not compile: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Whether a template refers to a helper this application does not offer.
 *
 * Scanned rather than trusted, because handlebars checks at render and `save` must
 * refuse before the write. The names are read off the source as handlebars itself
 * reads them, so a helper used as a block (`{{#foo}}`), inline (`{{foo x}}`) or as a
 * subexpression (`(foo x)`) is found in all three positions.
 *
 * Built-ins — `if`, `each`, `unless`, `with`, `lookup`, `log` — are not helpers this
 * application registered and are not treated as unknown: every handlebars install
 * provides them and refusing them would make `{{#if}}` unusable in a template.
 */
const BUILT_IN_HELPERS = new Set([
  'if',
  'unless',
  'each',
  'with',
  'lookup',
  'log',
  'blockHelperMissing',
  'helperMissing',
]);

/**
 * The helper names a source calls, as opposed to the variables it interpolates.
 *
 * The distinction is the whole reason this is not a regular expression over every
 * `{{name}}`: handlebars resolves `{{firstName}}` as a **variable** and
 * `{{actionLink url "Verify"}}` as a **helper call**, and only the second needs to be
 * on the whitelist. A scan that treated them alike refused every shipped template,
 * which is what the first version of this did.
 *
 * A helper call is one of:
 *
 * - `{{name arg}}` — a call with arguments
 * - `{{#name}}` / `{{#name arg}}` — a block helper, the `#` is in the capture
 * - `(name arg)` — a subexpression, which is how a helper is used inside `{{#if}}`
 *
 * `{{/if}}` is skipped: it closes a block and names nothing.
 */
function referencedHelpers(source: string): Set<string> {
  const found = new Set<string>();

  for (const match of source.matchAll(/\{\{([#/]?)\s*([^}]*?)\s*\}\}/g)) {
    const [, sigil, signature] = match;

    // A closing tag. `{{/if}}` names the block it closes, not a helper.
    if (sigil === '/') {
      continue;
    }

    const parts = signature.split(/\s+/).filter(Boolean);
    const [name] = parts;

    if (!name) {
      continue;
    }

    // A bare `{{name}}` is a variable. Everything else is a call.
    if (sigil !== '#' && parts.length === 1) {
      continue;
    }

    found.add(name);
  }

  for (const match of source.matchAll(/\(\s*([A-Za-z_][\w.]*)/g)) {
    if (match[1]) {
      found.add(match[1]);
    }
  }

  return found;
}

/**
 * Refuses a template that calls a helper this application does not offer.
 *
 * A separate check from the escaping one because the two failures are different in
 * kind: an unescaped expression is a security problem, and an unknown helper is a
 * correctness problem that would otherwise be found at 3am by somebody whose welcome
 * email is broken.
 *
 * @throws when the template names a helper that is not in `TEMPLATE_HELPERS`
 */
export function assertKnownHelpers(source: string, label: string): void {
  const unknown = [...referencedHelpers(source)].filter(
    (name) => !(name in TEMPLATE_HELPERS) && !BUILT_IN_HELPERS.has(name),
  );

  if (unknown.length > 0) {
    throw new Error(
      `The ${label} template uses ${unknown.map((n) => `"${n}"`).join(', ')}, ` +
        `which this application does not offer. Available helpers: ` +
        `${Object.keys(TEMPLATE_HELPERS).sort().join(', ')}. ` +
        'Block helpers such as {{#if}} and {{#each}} are always available.',
    );
  }
}

/** Renders a compiled part against data. */
export function renderPart(
  compiled: Handlebars.TemplateDelegate,
  data: Record<string, unknown>,
): string {
  return compiled(data);
}

export { actionLinkText };
