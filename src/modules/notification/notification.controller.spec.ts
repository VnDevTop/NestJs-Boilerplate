import { BadRequestException } from '@nestjs/common';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../common/interfaces/index.js';
import { NOTIFICATION_EVENT_KEYS } from './notification.events.js';
import { NotificationController } from './notification.controller.js';
import type {
  NotificationPreferencesService,
  PreferenceEntry,
} from './notification-preferences.service.js';

/**
 * These routes are the only way a user changes what the application tells the
 * operators, so the assertions are about what the controller refuses rather than
 * about what it forwards: an unknown event name written to the table would be a
 * preference nothing ever reads, and it would look like the mute had been saved.
 */

const USER = { id: 'u1', email: 'ada@example.com' } as RequestUser;

interface Harness {
  controller: NotificationController;
  apply: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
}

function harness(rows: PreferenceEntry[] = []): Harness {
  const apply = vi.fn().mockResolvedValue(undefined);
  const list = vi.fn().mockResolvedValue(rows);

  return {
    controller: new NotificationController({
      apply,
      list,
    } as unknown as NotificationPreferencesService),
    apply,
    list,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reading preferences', () => {
  it("answers with the caller's own rows and nothing else", async () => {
    // No admin variant on purpose: a route that let an administrator mute another
    // user's alerts would be a way to stop somebody being told their account was
    // just used.
    const h = harness([
      { event: 'user.registered', channel: 'slack', enabled: false },
    ]);

    const result = await h.controller.list(USER);

    expect(h.list).toHaveBeenCalledWith('u1');
    expect(result.preferences).toEqual([
      { event: 'user.registered', channel: 'slack', enabled: false },
    ]);
  });

  it('lists the events and channels a client may choose from', async () => {
    // A client cannot enumerate a closed list, so the answer has to carry it.
    const h = harness();

    const result = await h.controller.list(USER);

    expect(result.availableEvents).toEqual([...NOTIFICATION_EVENT_KEYS]);
    expect(result.availableChannels).toEqual([
      'console',
      'email',
      'telegram',
      'slack',
      'discord',
    ]);
  });

  it('is empty rather than absent for a user who changed nothing', async () => {
    await expect(harness().controller.list(USER)).resolves.toMatchObject({
      preferences: [],
    });
  });
});

describe('writing preferences', () => {
  it('passes a valid pair straight through', async () => {
    const h = harness();

    await h.controller.update(USER, {
      preferences: [
        { event: 'user.registered', channel: 'slack', enabled: false },
      ],
    });

    expect(h.apply).toHaveBeenCalledWith('u1', [
      { event: 'user.registered', channel: 'slack', enabled: false },
    ]);
  });

  it('applies several pairs in one call, so one route call is one eviction', async () => {
    const h = harness();

    await h.controller.update(USER, {
      preferences: [
        { event: 'user.registered', channel: 'slack', enabled: false },
        { event: 'auth.2fa.enabled', channel: 'console', enabled: false },
      ],
    });

    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.apply.mock.calls[0][1]).toHaveLength(2);
  });

  it('accepts an empty list as a no-op rather than an error', async () => {
    // A client that fetched the list and found nothing changed would send exactly
    // this, and refusing it would make "I have no preferences" un-saveable.
    const h = harness();

    await expect(
      h.controller.update(USER, { preferences: [] }),
    ).resolves.toBeUndefined();
    expect(h.apply).toHaveBeenCalledWith('u1', []);
  });

  it('rejects an unknown event, naming it', async () => {
    // The message names the value rather than saying "invalid enum", because a client
    // that sent a typo has to know which one. A pipe's message would leave it
    // guessing.
    const h = harness();

    await expect(
      h.controller.update(USER, {
        preferences: [
          { event: 'user.exploded', channel: 'slack', enabled: false },
        ],
      }),
    ).rejects.toThrow(/user\.exploded/);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('rejects an unknown channel, naming it', async () => {
    const h = harness();

    await expect(
      h.controller.update(USER, {
        preferences: [
          {
            event: 'user.registered',
            channel: 'carrier-pigeon' as never,
            enabled: false,
          },
        ],
      }),
    ).rejects.toThrow(/carrier-pigeon/);
  });

  it('rejects a non-boolean enabled, naming the pair it belongs to', async () => {
    const h = harness();

    await expect(
      h.controller.update(USER, {
        preferences: [
          {
            event: 'user.registered',
            channel: 'slack',
            enabled: 'yes' as unknown as boolean,
          },
        ],
      }),
    ).rejects.toThrow(/user\.registered on slack/);
  });

  it('rejects a body with no preferences array', async () => {
    const h = harness();

    await expect(h.controller.update(USER, {} as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('writes nothing when any pair in the batch is invalid', async () => {
    // Validated before applying rather than pair by pair, so a client cannot end up
    // with half a batch saved and an error, which looks like a save that worked.
    const h = harness();

    await expect(
      h.controller.update(USER, {
        preferences: [
          { event: 'user.registered', channel: 'slack', enabled: false },
          { event: 'user.exploded', channel: 'slack', enabled: false },
        ],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('lists the expected events in its own error, so the message is actionable', async () => {
    const h = harness();

    await expect(
      h.controller.update(USER, {
        preferences: [{ event: 'nope', channel: 'slack', enabled: false }],
      }),
    ).rejects.toThrow(new RegExp(NOTIFICATION_EVENT_KEYS[0]));
  });
});
