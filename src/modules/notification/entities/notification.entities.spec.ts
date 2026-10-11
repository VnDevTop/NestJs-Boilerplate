import { getMetadataArgsStorage } from 'typeorm';

import { describe, expect, it } from 'vitest';

import './index.js';

/**
 * These assert the table shapes rather than the classes, because the shape is what
 * the retention policy's predicates and the admin queries are written against. A
 * renamed column is a silent failure there: the delete would match nothing and the
 * run would report a clean night.
 *
 * Looked up by table name through the target class, following
 * `auth/entities/token.entities.spec.ts`. `getMetadataArgsStorage()` keeps tables,
 * columns, indices and relations in four separate lists, so a table's own metadata
 * is not enough to answer anything about its shape — and the `import './index.js'`
 * side effect is what registers the tables at all.
 */

const LOGS = 'notification_logs';
const PREFERENCES = 'notification_preferences';

function storage() {
  return getMetadataArgsStorage();
}

function targetOf(name: string) {
  return storage().tables.find((table) => table.name === name)?.target;
}

function columnsOf(name: string) {
  const target = targetOf(name);

  return target ? storage().columns.filter((c) => c.target === target) : [];
}

function columnOf(name: string, property: string) {
  return columnsOf(name).find((column) => column.propertyName === property);
}

function indexesOf(name: string) {
  const target = targetOf(name);

  return target
    ? storage().indices.filter((index) => index.target === target)
    : [];
}

function uniquesOf(name: string) {
  const target = targetOf(name);

  return target
    ? storage().uniques.filter((index) => index.target === target)
    : [];
}

function relationsOf(name: string) {
  const target = targetOf(name);

  return target
    ? storage().relations.filter((relation) => relation.target === target)
    : [];
}

/**
 * The property names an index covers.
 *
 * `columns` is `string[]` or a function producing one depending on the metadata kind,
 * so it is narrowed rather than assumed.
 */
function indexedColumns(name: string): string[] {
  return indexesOf(name).flatMap((index) => {
    const { columns } = index as { columns?: unknown };

    return Array.isArray(columns)
      ? columns.map((column) => String(column))
      : [];
  });
}

const namesOf = (name: string): string[] =>
  columnsOf(name).map((column) => column.propertyName);

describe('the notification_logs table', () => {
  it('maps to the table name the retention policy deletes from', () => {
    // The policy entry names the physical table, so a rename here would make every
    // nightly run error on a table it cannot find.
    expect(storage().tables.map((table) => table.name)).toContain(LOGS);
  });

  it('records the event and the channel as columns, not only inside a blob', () => {
    // An operator filters by these constantly, and a jsonb scan over a table that
    // grows on every registration is not an answer.
    expect(namesOf(LOGS)).toEqual(expect.arrayContaining(['event', 'channel']));
  });

  it('indexes createdAt, because the retention job deletes on it every night', () => {
    // Without this every run is a sequential scan of a table that only grows.
    expect(indexedColumns(LOGS)).toContain('createdAt');
  });

  it('indexes the event, because that is what an operator filters by', () => {
    expect(indexedColumns(LOGS)).toContain('event');
  });

  it('allows a null userId, because the retention anomaly belongs to nobody', () => {
    // A retention anomaly is a fact about the deployment, and a non-null column would
    // either refuse that row or force a fake user onto it.
    expect(columnOf(LOGS, 'userId')?.options?.nullable).toBe(true);
  });

  it('allows a null recipient, because a muted channel has nowhere to send', () => {
    expect(columnOf(LOGS, 'recipient')?.options?.nullable).toBe(true);
  });

  it('requires a status code only when there was one', () => {
    // A network failure never got far enough to have a status, and a defaulted 0
    // would read as "answered with 0" to anything scanning the column.
    expect(columnOf(LOGS, 'statusCode')?.options?.nullable).toBe(true);
  });

  it('stores the body, so a missed message can be reconstructed', () => {
    // The answer to "what did it actually say" belongs in the row rather than in a
    // template history a deploy has already overwritten.
    expect(namesOf(LOGS)).toContain('body');
  });

  it('caps the body, because a rendered event can be arbitrarily long', () => {
    // The truncation is in the service too; the column is the bound that makes it
    // necessary.
    expect(columnOf(LOGS, 'body')?.options?.length).toBe(1000);
  });

  it('carries no updatedAt, because nothing rewrites a log row', () => {
    // Append-only is the point. A row that can be edited is not evidence, and the
    // only removal is the retention job deleting by age.
    expect(namesOf(LOGS)).not.toContain('updatedAt');
  });

  it('carries no deletedAt, for the same reason', () => {
    expect(namesOf(LOGS)).not.toContain('deletedAt');
  });

  it('defaults attempts to one, so a row is never "how many?" with no answer', () => {
    expect(columnOf(LOGS, 'attempts')?.options?.default).toBe(1);
  });
});

describe('the notification_preferences table', () => {
  it('is unique per user, event and channel', () => {
    // One row per pair is what lets a user who muted Slack have not muted Telegram.
    // With a unique on (user, event) alone, the second channel's mute would collide
    // with the first.
    const uniques = uniquesOf(PREFERENCES);

    expect(uniques).toHaveLength(1);
    expect(uniques[0].columns).toEqual(
      expect.arrayContaining(['userId', 'event', 'channel']),
    );
  });

  it('defaults enabled to true, so a written row is never a surprise mute', () => {
    // The absence of a row already means on. A row defaulting to false would make
    // "insert the pair" and "mute the pair" the same statement.
    expect(columnOf(PREFERENCES, 'enabled')?.options?.default).toBe(true);
  });

  it('declares no relation to the user entity, unlike role_permissions', () => {
    // A soft-deleted user is hard deleted by the retention job thirty days later, so
    // a cascade would erase the preference at the moment an administrator restored
    // the account. The row outliving its user is harmless and the restore is not.
    expect(relationsOf(PREFERENCES)).toHaveLength(0);
  });

  it('keeps updatedAt, because this table is edited rather than appended to', () => {
    // The opposite of the log's rule, and deliberately: a mute is a value that is
    // changed, so `updatedAt` answers "when did they change their mind".
    expect(namesOf(PREFERENCES)).toContain('updatedAt');
  });

  it('indexes userId, because every read filters on it', () => {
    expect(indexedColumns(PREFERENCES)).toContain('userId');
  });

  it('stores the channel as a bounded varchar, because it is a fixed set', () => {
    // The controller validates it against five names, and the column length is what
    // stops a hand-written insert from filing a paragraph there.
    expect(columnOf(PREFERENCES, 'channel')?.options?.type).toBe('varchar');
    expect(columnOf(PREFERENCES, 'channel')?.options?.length).toBe(20);
  });
});
