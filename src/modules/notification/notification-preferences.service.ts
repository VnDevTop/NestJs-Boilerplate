import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { ConfigService } from '@nestjs/config';

import { authPreferenceKey, CacheService } from '../../core/cache/index.js';
import type { CacheConfig } from '../../configs/index.js';
import type { NotificationChannelName } from '../../configs/notification.config.js';
import { NotificationPreference } from './entities/index.js';
import type { NotificationEventKey } from './notification.events.js';

/** What `PATCH /notifications/preferences` carries: a truth per pair, not a diff. */
export interface PreferenceEntry {
  event: NotificationEventKey;
  channel: NotificationChannelName;
  enabled: boolean;
}

/**
 * Who receives what.
 *
 * **Reads come from the cache**, because they sit on the request path: every
 * notification checks this before it is delivered. The loader is one query for all
 * of a user's pairs rather than one per event, so a user with eight preferences
 * costs one read and not eight.
 *
 * **Writes are direct.** There is no cache write on the way out, only a delete of
 * the one key, and it is a delete rather than an update so the next read cannot
 * observe a value that is halfway through being written.
 *
 * Cached under `user:<id>:notifications` rather than `user:<id>`, for the same
 * reason the device versions are a separate key: this is read on every
 * notification rather than on every request, it is written by a different route,
 * and keeping them apart means a user with eight preferences does not carry them
 * in the hot entry read by everybody.
 */
@Injectable()
export class NotificationPreferencesService {
  private readonly logger = new Logger(NotificationPreferencesService.name);

  constructor(
    @InjectRepository(NotificationPreference)
    private readonly preferences: Repository<NotificationPreference>,
    private readonly cache: CacheService,
    private readonly configService: ConfigService,
  ) {}

  private get ttl(): number {
    // Reuses the auth TTL rather than adding a second one. A preference that is up
    // to a minute stale is a user who muted an event and saw it once more, which
    // is the same latency every other authorization answer in this application
    // already has, and one knob is easier to reason about than two that mean
    // roughly the same thing.
    return this.configService.getOrThrow<CacheConfig>('cache').authUserTtl;
  }

  /**
   * Whether this user accepts this event on this channel.
   *
   * **Opt-out, so the empty answer is yes.** A table nobody has written to yet must
   * not silence every notification, or the feature would look broken on a fresh
   * install and the fix would be "seed the table", which is the opposite of
   * opt-in-by-default.
   *
   * A failed read answers yes as well, because the cache turns an unreachable
   * redis into a miss and the loader then fails: a preference lookup must not be
   * able to take notification delivery down with it. The user receives one
   * notification they muted, which is a smaller problem than receiving none of
   * anything.
   */
  async isEnabled(
    userId: string,
    event: NotificationEventKey,
    channel: NotificationChannelName,
  ): Promise<boolean> {
    const entries = await this.entriesFor(userId);

    return entries.get(`${event}:${channel}`) !== false;
  }

  /** A user's explicit preferences, for the read side of the API. */
  async list(userId: string): Promise<PreferenceEntry[]> {
    const rows = await this.read(userId);

    return rows.map((row) => ({
      event: row.event as NotificationEventKey,
      channel: row.channel as NotificationChannelName,
      enabled: row.enabled,
    }));
  }

  /**
   * Applies a set of changes and drops the cache entry **once**, at the end.
   *
   * Per pair rather than a whole-list replace, because the route's job is "change
   * these" and a list replace would silently clear preferences the client never knew
   * about — a client built before an event existed would wipe it on every save.
   *
   * One eviction for the whole batch rather than one per pair. A user changing five
   * preferences is five writes and one delete, and an eviction between two writes
   * would let a concurrent read refill from a half-applied state and cache the
   * answer for the rest of the TTL. The same rule as every other invalidation in
   * this application: after the writes, and once.
   */
  async apply(
    userId: string,
    entries: readonly PreferenceEntry[],
  ): Promise<readonly PreferenceEntry[]> {
    for (const entry of entries) {
      const existing = await this.preferences.findOne({
        where: {
          userId,
          event: entry.event,
          channel: entry.channel,
        },
      });

      if (existing === null) {
        await this.preferences.insert({
          userId,
          event: entry.event,
          channel: entry.channel,
          enabled: entry.enabled,
        });

        continue;
      }

      // Unchanged rather than skipped: an explicit `enabled: true` on a row that
      // was already true is not a no-op the caller can see the effect of, and
      // writing it makes `updatedAt` mean "this was touched".
      existing.enabled = entry.enabled;

      await this.preferences.save(existing);
    }

    // After the writes, and only the one key. Same rule as the auth cache: a delete
    // that raced a write would let the next read refill from the row before it.
    await this.cache.delete(authPreferenceKey(userId));

    return entries;
  }

  /** Removes an override, so the event reverts to the default of on. */
  async clear(
    userId: string,
    event: NotificationEventKey,
    channel: NotificationChannelName,
  ): Promise<boolean> {
    const result = await this.preferences.delete({ userId, event, channel });

    await this.cache.delete(authPreferenceKey(userId));

    return (result.affected ?? 0) > 0;
  }

  /**
   * Every pair this user has an opinion about, as a lookup.
   *
   * Keyed `event:channel` because that is the only question the caller asks, and a
   * `Map` answers it without allocating a key string per check. Only explicit
   * `false` is recorded in the map, so absence and "on" are the same answer.
   */
  /**
   * Deletes every preference for a user whose account is being erased.
   *
   * **These are removed at request time, not by the retention job**, and that is a
   * deliberate asymmetry with the user row itself. The row is kept for thirty days
   * so an erasure made in anger can be undone; a channel choice is not part of the
   * person, and restoring an account should not restore a preference that said
   * "email me about this", because the address that preference referred to is
   * exactly what was erased.
   *
   * The alternative was a foreign key, and there is deliberately not one: a cascade
   * would erase a preference silently when the retention job hard-deleted the user,
   * which is the moment an operator might be about to restore. Erasing on request
   * makes the removal visible and attributable instead.
   */
  async forget(userId: string): Promise<void> {
    await this.preferences.delete({ userId });
  }

  private async entriesFor(userId: string): Promise<Map<string, boolean>> {
    const rows = await this.read(userId);

    return new Map(
      rows.map((row) => [`${row.event}:${row.channel}`, row.enabled]),
    );
  }

  /** The cached read. A miss runs the loader; a failure answers empty. */
  private async read(userId: string): Promise<NotificationPreference[]> {
    try {
      return await this.cache.wrap<NotificationPreference[]>(
        authPreferenceKey(userId),
        () => this.preferences.find({ where: { userId } }),
        { ttl: this.ttl },
      );
    } catch (error) {
      this.logger.warn(
        `Could not read notification preferences for ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return [];
    }
  }
}
