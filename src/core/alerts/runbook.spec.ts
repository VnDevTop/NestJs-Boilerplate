import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ALERT_RULES } from './alert.policy.js';

/**
 * A runbook is only useful if somebody can find the right page at 3am, and every
 * way it fails is silent: a link that 404s, a section renamed, a link that points
 * somewhere the alert does not actually fire from.
 *
 * These check the whole graph — alert rule to runbook section — without rendering
 * anything, because a link checker that needs the site built does not run in this
 * repository's test suite and therefore does not run at all.
 */

/** GitHub's slug rule, which is what the links are written against. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

const runbook = readFileSync(
  new URL('../../../docs/runbook.md', import.meta.url).pathname,
  'utf8',
);

/** Every `## ` heading, slugged. `### ` is deliberately not included. */
function sections(): Set<string> {
  return new Set(
    [...runbook.matchAll(/^## (.+)$/gm)].map((match) =>
      slug(match[1] as string),
    ),
  );
}

describe('the runbook', () => {
  it('has a section for every alert that links to one', () => {
    // The failure this catches: a rule names a section, somebody renames the
    // heading, and a page notification at 3am lands on a 404.
    const present = sections();

    for (const rule of ALERT_RULES) {
      const anchor = rule.runbook.replace('runbook.md#', '');

      expect(
        present,
        `${rule.name} links to a section that does not exist`,
      ).toContain(anchor);
    }
  });

  it('has a section for every scenario the plan names', () => {
    // provider outage, redis loss, queue backlog, tracing a missing email — plus the
    // three the alerts link to.
    const present = sections();

    for (const scenario of [
      'mail-is-failing',
      'jobs-are-dead-lettering',
      'the-retention-job-has-not-run',
      'the-queue-is-backed-up',
      'redis-has-been-lost',
      'tracing-a-missing-email',
    ]) {
      expect(present, scenario).toContain(scenario);
    }
  });

  it('has no internal link pointing at a section that is not there', () => {
    const present = sections();
    const links = [...runbook.matchAll(/\]\(#([\w-]+)\)/g)].map(
      (match) => match[1] as string,
    );

    for (const link of links) {
      expect(present, `runbook.md links to #${link}`).toContain(link);
    }
  });

  it('gives every alert-linked section something to do, not just a diagnosis', () => {
    // An alert that says what happened and not what to check is a ticket somebody
    // has to research from scratch. Each section needs a heading beyond "what is
    // this" — here, a numbered action list or a runnable command.
    for (const rule of ALERT_RULES) {
      const anchor = rule.runbook.replace('runbook.md#', '');
      const heading = [...runbook.matchAll(/^## (.+)$/gm)].find(
        (match) => slug(match[1] as string) === anchor,
      )?.[1];

      expect(heading, anchor).toBeDefined();

      const start = runbook.indexOf(`## ${heading}`);
      const next = runbook.indexOf('\n## ', start + 1);
      const body = runbook.slice(start, next === -1 ? undefined : next);

      expect(
        /### What to do|\bcurl |\bnpm install|redis-cli|SELECT /u.test(body),
        `${anchor} has no action in it`,
      ).toBe(true);
    }
  });

  it('says the request id is how you find a send, because that is the whole point', () => {
    const start = runbook.indexOf('## Tracing a missing email');
    const body = runbook.slice(start);

    expect(body).toContain('mail_logs');
    expect(body).toContain('requestId');
  });
});
