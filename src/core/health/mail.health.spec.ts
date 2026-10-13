import { describe, expect, it, vi } from 'vitest';

import { MailHealthIndicator } from './mail.health.js';

/**
 * The health check must never be the thing that breaks the application.
 *
 * Mail failing degrades a signup into one the owner finishes from their inbox and
 * a reset into a wait. It does not take anything down. So the rule under test
 * throughout is: `degraded`, never `down` — because `down` makes Terminus throw
 * 503, an orchestrator pulls every instance, and a mail provider outage becomes an
 * outage of a system that was still answering requests.
 */

function harness(
  options: {
    name?: string;
    verify?: () => Promise<boolean>;
    send?: unknown;
  } = {},
) {
  const transport = {
    name: options.name ?? 'smtp',
    send: options.send ?? vi.fn(async () => ({ accepted: [], rejected: [] })),
    ...(options.verify ? { verify: options.verify } : {}),
  };

  const service = {
    transportName: transport.name,
  };

  return {
    indicator: new MailHealthIndicator(service as never, transport as never),
    transport,
  };
}

describe('a working transport', () => {
  it('is up', async () => {
    const h = harness({ verify: async () => true });

    const result = await h.indicator.isHealthy();

    expect(result.mail).toMatchObject({ status: 'up', transport: 'smtp' });
  });

  it('names the transport, because "why did nobody get the mail" often starts there', async () => {
    const h = harness({ name: 'sendgrid', verify: async () => true });

    const result = await h.indicator.isHealthy();

    expect(result.mail).toMatchObject({ transport: 'sendgrid' });
  });
});

describe('the memory transport in production', () => {
  it('is degraded rather than up, because every mail is being silently discarded', async () => {
    const h = harness({ name: 'memory' });

    const result = await h.indicator.isHealthy();

    expect(result.mail).toMatchObject({
      status: 'degraded',
      transport: 'memory',
    });
  });

  it('says so in words, because the name alone reads like a configuration choice', async () => {
    const h = harness({ name: 'memory' });

    const result = await h.indicator.isHealthy();

    expect(result.mail).toMatchObject({
      reason: expect.stringContaining('not being delivered'),
    });
  });

  it('does not verify anything, since there is nothing out there to reach', async () => {
    const verify = vi.fn(async () => true);
    const h = harness({ name: 'memory', verify });

    await h.indicator.isHealthy();

    expect(verify).not.toHaveBeenCalled();
  });
});

describe('a transport that reports itself unusable', () => {
  it('is degraded', async () => {
    const h = harness({ verify: async () => false });

    const result = await h.indicator.isHealthy();

    expect(result.mail).toMatchObject({ status: 'degraded' });
  });

  it('carries a reason rather than leaving an operator to guess', async () => {
    const h = harness({ verify: async () => false });

    const result = await h.indicator.isHealthy();

    expect(result.mail).toMatchObject({
      reason: expect.stringContaining('unusable'),
    });
  });
});

describe('a transport that throws', () => {
  it('is degraded, and the check does not throw', async () => {
    // The check runs inside a health probe. A throw here would escape into
    // Terminus, which turns it into a failed readiness — i.e. an outage caused by
    // the thing meant to detect one.
    const h = harness({
      verify: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    await expect(h.indicator.isHealthy()).resolves.toMatchObject({
      mail: { status: 'degraded' },
    });
  });
});

describe('a transport with no verify', () => {
  it('is up, and says it was not verified', async () => {
    // Absence of a probe is a gap, not a failure. A transport whose provider has
    // no cheap readiness call is better off omitting one than shipping a probe
    // that sends mail — so reporting `up, verified: false` is the honest answer
    // and inventing a check would not be.
    const h = harness({ name: 'ses' });

    const result = await h.indicator.isHealthy();

    expect(result.mail).toMatchObject({
      status: 'up',
      transport: 'ses',
      verified: false,
    });
  });
});

describe('what this check never does', () => {
  it('sends nothing, because there is no recipient who wants a probe', async () => {
    // Every send is a real message to a real mailbox, and a provider rate limit
    // would eventually refuse the probe and take the real queue down with it — the
    // health check causing the outage it exists to detect.
    const h = harness({ name: 'ses' });

    await h.indicator.isHealthy();

    expect(h.transport.send).not.toHaveBeenCalled();
  });
});
