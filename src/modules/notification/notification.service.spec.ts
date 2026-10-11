import type { MockedFunction } from 'vitest';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NotificationConfig } from '../../configs/notification.config.js';
import type {
  NotificationChannel,
  NotificationPayload,
} from './channels/index.js';
import { NOTIFICATION_CHANNELS } from './notification.service.js';
import {
  NOTIFICATION_LOG_WRITER,
  NotificationService,
} from './notification.service.js';
import type { LogEntry } from './types/index.js';

/**
 * The delivery service is where the phase's central promise is kept: a broken
 * channel must never take the request that noticed something down with it.
 *
 * Every test here runs the real service with fake channels rather than asserting on
 * mocks of the service, because the property is about the aggregate — "Slack still
 * got it while Telegram was down" — and a mock of the service would assert nothing.
 */

const PAYLOAD_DATA = {
  'user.registered': { email: 'ada@example.com', firstName: 'Ada' },
} as const;

const DELIVERY = {
  timeout: 5_000,
  retries: 2,
  retryDelay: 1,
  throwOnFailure: false,
};

function config(
  overrides: Partial<NotificationConfig> = {},
): NotificationConfig {
  return {
    enabled: true,
    channels: {
      console: true,
      email: false,
      telegram: false,
      slack: false,
      discord: false,
    },
    telegram: { topics: {} },
    slack: {},
    discord: {},
    email: { to: [] },
    delivery: DELIVERY,
    ...overrides,
  } as NotificationConfig;
}

/**
 * A channel with a `send` the test can assert on.
 *
 * `Omit` rather than `extends`: the entity's `send` returns `ChannelResult`, while the
 * fake resolves a partial one so a test can say "refused with a 401" without stating
 * the four fields it does not care about. Extending would force every fake to be
 * complete, and completeness here is noise.
 */
type FakeChannel = Omit<NotificationChannel, 'send'> & {
  send: MockedFunction<NotificationChannel['send']>;
};

function channel(
  name: NotificationChannel['name'],
  result: Partial<{
    delivered: boolean;
    status: number;
    permanent: boolean;
    error: string;
    recipient: string;
  }> = {},
): FakeChannel {
  return {
    name,
    isEnabled: () => true,
    send: vi.fn<NotificationChannel['send']>(async () => ({
      delivered: true,
      recipient: name,
      ...result,
    })),
  };
}

interface Harness {
  service: NotificationService;
  logged: LogEntry[];
  muted: Set<string>;
  isEnabled: ReturnType<typeof vi.fn>;
}

function harness(
  options: {
    channels?: NotificationChannel[];
    config?: NotificationConfig;
    muted?: string[];
    /** Replaces the preference service with one that throws, to prove isolation. */
    preferencesThrow?: boolean;
  } = {},
): Harness {
  const logged: LogEntry[] = [];
  const muted = new Set(options.muted ?? []);

  const isEnabled = vi.fn(
    async (_userId: string, event: string, name: string) => {
      if (options.preferencesThrow) {
        throw new Error('preference store is down');
      }

      return !muted.has(`${event}:${name}`);
    },
  );

  const logs = {
    record: vi.fn(async (entry: LogEntry) => {
      logged.push(entry);
    }),
  };

  const service = new NotificationService(
    options.channels ?? [],
    logs,
    { isEnabled } as never,
    options.config ?? config(),
  );

  return { service, logged, muted, isEnabled };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the disabled paths', () => {
  it('does nothing at all when notifications are off', async () => {
    // Nothing attempted, nothing logged, nothing to retry. A deployment that turned
    // the master switch off must not fill the dead-letter list with work it was told
    // not to do.
    const slack = channel('slack');
    const h = harness({
      channels: [slack],
      config: config({ enabled: false }),
    });

    const outcome = await h.service.notify(
      'user.registered',
      PAYLOAD_DATA['user.registered'],
    );

    expect(outcome.skipped).toBe(true);
    expect(outcome.deliveries).toEqual([]);
    expect(slack.send).not.toHaveBeenCalled();
    expect(h.logged).toEqual([]);
  });

  it('reports skipped rather than failed when no channel is enabled', async () => {
    // The distinction matters to the queue: a skip is a success, so a job that found
    // nothing to do is not retried and not dead-lettered.
    const h = harness({ channels: [] });

    const outcome = await h.service.notify(
      'user.registered',
      PAYLOAD_DATA['user.registered'],
    );

    expect(outcome).toMatchObject({ skipped: true, deliveries: [] });
  });

  it('groups every attempt under one notification id', async () => {
    // So a partial delivery across four channels is visible as one thing rather than
    // as four unrelated messages.
    const h = harness({
      channels: [channel('slack'), channel('telegram')],
    });

    const outcome = await h.service.notify(
      'user.registered',
      PAYLOAD_DATA['user.registered'],
    );

    const ids = new Set(h.logged.map((entry) => entry.notificationId));

    expect(ids.size).toBe(1);
    expect(outcome.notificationId).toBe(h.logged[0].notificationId);
  });
});

describe('failure isolation', () => {
  it('delivers to the healthy channel when another one refuses', async () => {
    // The property the whole phase exists for. A Telegram outage must not cost
    // anybody their Slack alert.
    const slack = channel('slack');
    const telegram = channel('telegram', {
      delivered: false,
      status: 500,
      error: 'status 500',
    });
    const h = harness({ channels: [telegram, slack] });

    const outcome = await h.service.notify(
      'user.registered',
      PAYLOAD_DATA['user.registered'],
    );

    expect(slack.send).toHaveBeenCalledTimes(1);
    expect(outcome.deliveries).toEqual([
      expect.objectContaining({ channel: 'telegram', delivered: false }),
      expect.objectContaining({ channel: 'slack', delivered: true }),
    ]);
  });

  it('keeps going after a channel throws rather than unwinding the loop', async () => {
    const throwing = channel('telegram');
    throwing.send.mockRejectedValue(new Error('socket hang up'));
    const slack = channel('slack');
    const h = harness({ channels: [throwing, slack] });

    const outcome = await h.service.notify(
      'user.registered',
      PAYLOAD_DATA['user.registered'],
    );

    expect(slack.send).toHaveBeenCalledTimes(1);
    expect(outcome.deliveries[0]).toMatchObject({
      channel: 'telegram',
      delivered: false,
      error: 'socket hang up',
    });
  });

  it('logs a row for a failure, because the refusal is the record an operator needs', async () => {
    const h = harness({
      channels: [
        channel('telegram', {
          delivered: false,
          status: 401,
          error: 'status 401',
        }),
      ],
    });

    await h.service.notify('user.registered', PAYLOAD_DATA['user.registered']);

    expect(h.logged).toEqual([
      expect.objectContaining({
        channel: 'telegram',
        delivered: false,
        statusCode: 401,
        error: 'status 401',
      }),
    ]);
  });

  it('logs a row for a success too, so "did it arrive" is answerable', async () => {
    const h = harness({ channels: [channel('slack')] });

    await h.service.notify('user.registered', PAYLOAD_DATA['user.registered']);

    expect(h.logged[0]).toMatchObject({ channel: 'slack', delivered: true });
  });

  it('stores the rendered body, so a missed message can be reconstructed', async () => {
    // The template history a deploy has already overwritten is not an answer to
    // "what did it actually say".
    const h = harness({ channels: [channel('slack')] });

    await h.service.notify('user.registered', PAYLOAD_DATA['user.registered']);

    expect(h.logged[0].body).toContain('ada@example.com');
  });

  it('carries the rendered headline and body to the channel, not the raw data', async () => {
    // Two channels rendering the same event independently is how the Slack copy and
    // the Telegram copy drift into saying different things.
    const slack = channel('slack');
    const h = harness({ channels: [slack] });

    await h.service.notify('user.registered', PAYLOAD_DATA['user.registered']);

    expect(slack.send).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user.registered',
        headline: expect.stringContaining('ada@example.com'),
        body: expect.stringContaining('Address:'),
      }) as NotificationPayload,
    );
  });
});

describe('the retry budget', () => {
  it('retries a transient failure and succeeds on the second attempt', async () => {
    const flaky = channel('slack');
    flaky.send
      .mockResolvedValueOnce({ delivered: false, error: 'timeout' })
      .mockResolvedValueOnce({ delivered: true, recipient: 'slack' });
    const h = harness({ channels: [flaky] });

    const outcome = await h.service.notify(
      'user.registered',
      PAYLOAD_DATA['user.registered'],
    );

    expect(flaky.send).toHaveBeenCalledTimes(2);
    expect(outcome.deliveries[0]).toMatchObject({
      delivered: true,
      attempts: 2,
    });
  });

  it('spends only its own budget on the channel that failed', async () => {
    // The property that justifies the loop living here rather than in the queue: a
    // queue retry would re-attempt every channel for the sake of the one that failed,
    // and the Slack copy would arrive three times because Telegram was down.
    const slack = channel('slack');
    const telegram = channel('telegram', {
      delivered: false,
      error: 'timeout',
    });
    const h = harness({
      channels: [telegram, slack],
      config: config({ delivery: { ...DELIVERY, retries: 2, retryDelay: 1 } }),
    });

    await h.service.notify('user.registered', PAYLOAD_DATA['user.registered']);

    expect(telegram.send).toHaveBeenCalledTimes(3);
    expect(slack.send).toHaveBeenCalledTimes(1);
  });

  it('tries once when retries is zero, rather than treating zero as unset', async () => {
    // `retries: 0` means "do not retry", which is different from "use the default".
    const broken = channel('slack', { delivered: false, error: 'nope' });
    const h = harness({
      channels: [broken],
      config: config({ delivery: { ...DELIVERY, retries: 0, retryDelay: 1 } }),
    });

    await h.service.notify('user.registered', PAYLOAD_DATA['user.registered']);

    expect(broken.send).toHaveBeenCalledTimes(1);
  });

  it('stops immediately on a permanent refusal rather than burning the budget', async () => {
    // A revoked token answers identically every time, so retrying only delays the
    // dead-letter entry that says the credential is wrong.
    const broken = channel('slack', {
      delivered: false,
      status: 401,
      permanent: true,
      error: 'status 401',
    });
    const h = harness({ channels: [broken] });

    await h.service.notify('user.registered', PAYLOAD_DATA['user.registered']);

    expect(broken.send).toHaveBeenCalledTimes(1);
  });

  it('records how many attempts it took, since "was it retried" is a real question', async () => {
    const broken = channel('slack', { delivered: false, error: 'nope' });
    const h = harness({
      channels: [broken],
      config: config({ delivery: { ...DELIVERY, retries: 1, retryDelay: 1 } }),
    });

    await h.service.notify('user.registered', PAYLOAD_DATA['user.registered']);

    expect(h.logged[0].attempts).toBe(2);
  });

  it('waits longer before each retry', async () => {
    // An immediate retry against a channel that is rate-limiting is the same
    // request the provider just refused.
    const broken = channel('slack', { delivered: false, error: 'nope' });
    const h = harness({
      channels: [broken],
      config: config({ delivery: { ...DELIVERY, retries: 2, retryDelay: 20 } }),
    });

    const startedAt = Date.now();

    await h.service.notify('user.registered', PAYLOAD_DATA['user.registered']);

    // 20ms then 40ms. Asserted loosely: the point is that it is not zero, and a
    // tight bound would make the suite flaky on a loaded machine.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
  });
});

describe('preferences', () => {
  it('skips a channel the user muted, and records that it was skipped', async () => {
    // Recorded rather than silently dropped: "the user muted this" and "the channel
    // was never tried" look identical in a delivery count, and only the first is
    // something the user needs to be able to confirm.
    const slack = channel('slack');
    const h = harness({
      channels: [slack],
      muted: ['user.registered:slack'],
    });

    const outcome = await h.service.notify(
      'user.registered',
      PAYLOAD_DATA['user.registered'],
      { userId: 'u1' },
    );

    expect(slack.send).not.toHaveBeenCalled();
    expect(outcome.deliveries[0]).toMatchObject({
      channel: 'slack',
      delivered: false,
      skipped: true,
      attempts: 0,
    });
    expect(h.logged[0]).toMatchObject({
      delivered: false,
      attempts: 0,
      error: 'muted by the recipient',
    });
  });

  it('asks once per channel, not once per notification', async () => {
    const h = harness({ channels: [channel('slack'), channel('telegram')] });

    await h.service.notify('user.registered', PAYLOAD_DATA['user.registered'], {
      userId: 'u1',
    });

    expect(h.isEnabled).toHaveBeenCalledTimes(2);
  });

  it('does not consult preferences when the event has no user', async () => {
    // The retention anomaly belongs to the deployment. A lookup would find nothing
    // and answer the same either way, and the extra query is on the delivery path.
    const h = harness({ channels: [channel('slack')] });

    await h.service.notify('maintenance.retention.anomaly', {
      reason: 'timeout',
      pending: [],
      failed: [],
      durationMs: 1,
    });

    expect(h.isEnabled).not.toHaveBeenCalled();
  });

  it('attaches the user id to the log row, so the history can be filtered', async () => {
    const h = harness({ channels: [channel('slack')] });

    await h.service.notify('user.registered', PAYLOAD_DATA['user.registered'], {
      userId: 'u1',
    });

    expect(h.logged[0].userId).toBe('u1');
  });

  it('records a null user for a deployment-level event rather than a wrong one', async () => {
    const h = harness({ channels: [channel('slack')] });

    await h.service.notify('maintenance.retention.anomaly', {
      reason: 'timeout',
      pending: [],
      failed: [],
      durationMs: 1,
    });

    expect(h.logged[0].userId).toBeUndefined();
  });

  it('delivers anyway when the preference lookup fails', async () => {
    // Fails toward the noisy side on purpose. The alternative is a database outage
    // silencing every notification in the deployment, which is a far worse failure
    // than one user receiving one event they had muted — and this service is
    // already inside a job, so there is no request to protect by throwing.
    const slack = channel('slack');
    const h = harness({ channels: [slack], preferencesThrow: true });

    const outcome = await h.service.notify(
      'user.registered',
      PAYLOAD_DATA['user.registered'],
      { userId: 'u1' },
    );

    expect(slack.send).toHaveBeenCalledTimes(1);
    expect(outcome.deliveries[0]).toMatchObject({ delivered: true });
  });

  it('does not retry a muted channel, because retrying cannot un-mute it', async () => {
    const slack = channel('slack');
    const h = harness({
      channels: [slack],
      muted: ['user.registered:slack'],
      config: config({ delivery: { ...DELIVERY, retries: 2, retryDelay: 1 } }),
    });

    await h.service.notify('user.registered', PAYLOAD_DATA['user.registered'], {
      userId: 'u1',
    });

    expect(slack.send).not.toHaveBeenCalled();
  });
});

describe('the active channel list', () => {
  it('names the channels a notification would reach right now', async () => {
    // For the health check. Reporting the configured set rather than the enabled one
    // would say "telegram" for a deployment that has no token.
    const h = harness({ channels: [channel('slack'), channel('telegram')] });

    expect(h.service.activeChannels()).toEqual(['slack', 'telegram']);
  });
});

describe('the injection tokens', () => {
  it('are distinct, because the service takes the channel list as one and the log as the other', () => {
    expect(NOTIFICATION_CHANNELS).not.toBe(NOTIFICATION_LOG_WRITER);
  });
});
