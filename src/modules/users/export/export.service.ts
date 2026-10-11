import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Readable } from 'node:stream';
import { DataSource } from 'typeorm';

import { UserDevice } from '../../auth/entities/user-device.entity.js';
import { RefreshToken } from '../../auth/entities/refresh-token.entity.js';
import { PasswordHistoryEntry } from '../../auth/entities/password-history.entity.js';
import { NotificationPreference } from '../../notification/entities/index.js';
import { User } from '../entities/index.js';
import { csvStream, jsonStream } from './csv.util.js';

export type ExportFormat = 'csv' | 'json';

interface ExportSection {
  name: string;
  entity: unknown;
  table: string;
  /** The user's own row is keyed on `id`; every child table on `userId`. */
  whereColumn: 'id' | 'userId';
  columns: readonly string[];
}

/**
 * What an export contains, declared rather than derived.
 *
 * An export is a promise about what a person gets, and "whatever the entity happens
 * to have this month" is not a promise anybody can hold you to — adding a column to
 * an entity would silently change what a subject access request returns.
 *
 * The list is also where the exclusions are visible, which is the next point.
 *
 * ## What is not here, and why
 *
 * - **`users.password`** — a credential. It is not excluded by a filter at render
 *   time; it is never **selected**, so it never leaves postgres. A redaction applied
 *   later is a redaction somebody can forget.
 * - **`two_factor_secrets.secretCiphertext` / `secretIv` / `secretAuthTag`** — the
 *   two-factor secret, encrypted. Handing somebody the ciphertext of their own
 *   secret hands over the second factor, and this endpoint is authenticated by the
 *   first one.
 * - **`two_factor_secrets.recoveryCodes`** — stored in the clear, same reasoning.
 * - **`password_history.passwordHash`** — every password this account has ever had,
 *   hashed. A data subject is entitled to their data, not to their credentials, and
 *   a history of hashes is a cracking target that does not belong in a file people
 *   email to each other.
 * - **`refresh_tokens.jti`, `tokenHash`, `replacedById`** — live bearer
 *   credentials. `expiresAt`, `revokedAt` and `revokedReason` *are* included:
 *   knowing when a session existed and how it ended is what a person suspecting an
 *   intruder wants, and holding the token is not.
 *
 * What is included that people usually forget to offer: **devices**, with their ip
 * address and user agent — the exact thing somebody who thinks someone else has
 * their password wants to see — and **notification preferences**.
 *
 * There is no audit row for reading an export. The question "who called this" is
 * answered by the authentication layer, and the answer to "what did they get" is
 * the export itself.
 */
const SECTIONS: readonly ExportSection[] = [
  {
    name: 'user',
    entity: User,
    table: 'users',
    whereColumn: 'id',
    columns: [
      'id',
      'email',
      'firstName',
      'lastName',
      'role',
      'isActive',
      'isManager',
      'isEmailVerified',
      'lockedAt',
      'sessionsVersion',
      'createdAt',
      'updatedAt',
    ],
  },
  {
    name: 'devices',
    entity: UserDevice,
    table: 'user_devices',
    whereColumn: 'userId',
    columns: [
      'id',
      'deviceName',
      'ipAddress',
      'userAgent',
      'isActive',
      'sessionsVersion',
      'createdAt',
      'updatedAt',
    ],
  },
  {
    name: 'sessions',
    entity: RefreshToken,
    table: 'refresh_tokens',
    whereColumn: 'userId',
    columns: [
      'id',
      'deviceId',
      'expiresAt',
      'revokedAt',
      'revokedReason',
      'ipAddress',
      'createdAt',
    ],
  },
  {
    name: 'notifications',
    entity: NotificationPreference,
    table: 'notification_preferences',
    whereColumn: 'userId',
    columns: ['id', 'event', 'channel', 'enabled', 'createdAt', 'updatedAt'],
  },
  {
    name: 'passwordHistory',
    entity: PasswordHistoryEntry,
    table: 'password_history',
    whereColumn: 'userId',
    // The reason and the date, never the hash.
    columns: ['id', 'reason', 'createdAt'],
  },
];

@Injectable()
export class ExportService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * The export, in one format.
   *
   * **Every query is `userId`-scoped and selects named columns — never `*`.** That
   * is the mechanism behind the exclusions above rather than a restatement of them:
   * a column that is not selected cannot be rendered.
   *
   * `.stream()` hands TypeORM's cursor to the response, so an account with a decade
   * of sessions produces a decade of rows without any of them being held at once,
   * and a slow client and a slow query cannot each buffer for the other. The
   * alternative — `find()` then render — fails in memory on exactly the accounts
   * with the most data, which are the ones asking.
   */
  stream(userId: string, format: ExportFormat): Readable {
    // The generators are built here and consumed by the writer, so the queries are
    // not started until something reads the first byte. An export that opened five
    // cursors at request time would hold five of them for a client on a slow link.
    const sections = () =>
      SECTIONS.map((section) => ({
        name: section.name,
        columns: section.columns,
        rows: this.rowsFor(section, userId),
      }));

    return format === 'json' ? jsonStream(sections()) : csvStream(sections());
  }

  private async *rowsFor(
    section: ExportSection,
    userId: string,
  ): AsyncGenerator<Record<string, unknown>> {
    const cursor = this.dataSource
      .createQueryBuilder()
      .select([...section.columns])
      .from(section.entity as never, section.table)
      .where(`"${section.whereColumn}" = :userId`, { userId })
      .stream();

    // `stream()` is typed as a `Promise<ReadStream>`; it is a `ReadStream`, which
    // is async-iterable in Node. The cast is at that boundary and nowhere else.
    const rows = cursor as unknown as AsyncIterable<Record<string, unknown>>;

    for await (const row of rows) {
      yield row;
    }
  }

  /** The section names, for the `Content-Disposition` filename and the docs. */
  static sectionNames(): string[] {
    return SECTIONS.map((section) => section.name);
  }

  /** Every column that can appear, for a test that asserts on the exclusions. */
  static columnsFor(section: ExportSection['name']): readonly string[] {
    return SECTIONS.find((found) => found.name === section)?.columns ?? [];
  }
}
