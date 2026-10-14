import { ConfigService } from '@nestjs/config';
import type { RedisClientType } from 'redis';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RedisConfig } from '../../configs/redis.config.js';
import {
  REDIS_CLIENT_FACTORY,
  RedisClientService,
  type RedisClientFactory,
} from './redis-client.service.js';

/**
 * The metadata keys Nest writes `@Inject` and `@Optional` into, named rather
 * than repeated inline.
 */
const SELF_DECLARED_DEPS_METADATA = 'self:paramtypes';
const OPTIONAL_DEPS_METADATA = 'optional:paramtypes';

const config: RedisConfig = {
  url: 'redis://localhost:6379/1',
  keyPrefix: 'app:redis',
  connectTimeout: 2000,
  disableOfflineQueue: true,
};

function configService(): ConfigService {
  return { getOrThrow: () => config } as unknown as ConfigService;
}

interface MutableClient extends Record<string, unknown> {
  isReady: boolean;
}

/** The smallest client that satisfies what the service calls. */
function fakeClient(overrides: Record<string, unknown> = {}) {
  const client = {
    isReady: true,
    isOpen: true,
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    lPush: vi.fn().mockResolvedValue(1),
    lTrim: vi.fn().mockResolvedValue('OK'),
    lLen: vi.fn().mockResolvedValue(0),
    ...overrides,
  } as unknown as MutableClient;

  return client as unknown as RedisClientType & {
    set: ReturnType<typeof vi.fn>;
  };
}

function build(clientFactory: RedisClientFactory = () => fakeClient()): {
  service: RedisClientService;
  factory: RedisClientFactory;
} {
  const factory = vi.fn(clientFactory) as RedisClientFactory;

  return { service: new RedisClientService(configService(), factory), factory };
}

describe('how Nest constructs RedisClientService', () => {
  /**
   * The class has to carry `@Injectable()`.
   *
   * Without it Nest emits no `design:paramtypes`, and a class with no decorator is
   * constructed with **no arguments at all** — so `configService` was `undefined`
   * and the first redis command died with "Cannot read properties of undefined
   * (reading 'getOrThrow')". Every test in this file passes either way, because
   * each one constructs the service by hand and supplies its own dependencies.
   *
   * This reads the emitted metadata rather than the container, so it names the
   * actual cause instead of its symptom.
   */
  it('declares its dependencies for the injector', () => {
    const parameters = Reflect.getMetadata(
      'design:paramtypes',
      RedisClientService,
    ) as unknown[] | undefined;

    expect(parameters?.[0]).toBe(ConfigService);
  });

  it('takes the client factory as an optional injected value, not as a type', () => {
    // A factory is a function; `design:paramtypes` for one is `Function`, which is
    // not a provider anywhere in the container. `@Inject` names the token and
    // `@Optional` keeps it optional.
    const injected = Reflect.getMetadata(
      SELF_DECLARED_DEPS_METADATA,
      RedisClientService,
    ) as { index: number; param: unknown }[] | undefined;

    // `@Inject` records the token itself, not an object holding it.
    const factoryToken = injected?.find((dep) => dep.index === 1)?.param;

    expect(factoryToken).toBe(REDIS_CLIENT_FACTORY);

    const optional = Reflect.getMetadata(
      OPTIONAL_DEPS_METADATA,
      RedisClientService,
    ) as number[] | undefined;

    expect(optional).toContain(1);
  });
});

describe('RedisClientService connection', () => {
  it('does not connect at construction, so an unreachable redis does not block boot', () => {
    const { factory } = build();

    // The factory is not called until something needs the client, which is what
    // lets a deployment start with redis down and fall back to in-process jobs.
    expect(factory).not.toHaveBeenCalled();
  });

  it('connects on first use', async () => {
    const { service, factory } = build();

    await service.setIfAbsent('k', 'v', 60);

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('reuses one client across commands', async () => {
    const { service, factory } = build();

    await service.setIfAbsent('k', 'v', 60);
    await service.setIfAbsent('k', 'v', 60);

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('makes one connection attempt when several callers arrive during an outage', async () => {
    // Without memoising, a burst while redis is down makes one attempt per
    // caller, and each one is a connect timeout.
    let attempts = 0;
    const { service } = build(() => {
      attempts += 1;

      const client = fakeClient({
        connect: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      });

      return client;
    });

    await Promise.all([
      service.setIfAbsent('a', '1', 60),
      service.setIfAbsent('b', '1', 60),
      service.setIfAbsent('c', '1', 60),
    ]);

    expect(attempts).toBe(1);
  });

  it('attaches an error listener, so a socket error is not an unhandled event', async () => {
    // An 'error' event with no listener takes the process down.
    const client = fakeClient();
    const { service } = build(() => client);

    await service.setIfAbsent('k', 'v', 60);

    expect(client.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('destroys a client that failed to connect, rather than leaking it', async () => {
    const client = fakeClient({
      connect: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    const { service } = build(() => client);

    await service.setIfAbsent('k', 'v', 60);

    expect(client.destroy).toHaveBeenCalled();
  });

  it('reports not ready while there is no client, and ready once connected', async () => {
    const client = fakeClient();
    (client as unknown as MutableClient).isReady = false;
    const { service } = build(() => client);

    expect(service.isReady()).toBe(false);

    (client as unknown as MutableClient).isReady = true;
    await service.setIfAbsent('k', 'v', 60);

    expect(service.isReady()).toBe(true);
  });

  it('reports failure as a miss rather than throwing', async () => {
    const { service } = build(() =>
      fakeClient({
        connect: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      }),
    );

    // A throw here would turn a redis outage into a 500 on register.
    await expect(service.setIfAbsent('k', 'v', 60)).resolves.toBeNull();
  });
});

describe('RedisClientService key namespacing', () => {
  it('prefixes every key with the redis namespace', async () => {
    const client = fakeClient();
    const { service } = build(() => client);

    await service.setIfAbsent('dedupe:abc', 'v', 60);
    await service.release('dedupe:abc');
    await service.pushToList('dead', 'entry');
    await service.listLength('dead');

    // The raw client does not namespace anything; keyv does, and cache.module
    // uses keyv. Without this prefix the queue keys land beside the cache keys on
    // a shared server, which is the collision the separate namespace prevents.
    const calledKeys = [
      client.set,
      client.del,
      client.lPush,
      client.lTrim,
      client.lLen,
    ].map(
      (call) => (call as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0],
    );

    expect(calledKeys).toHaveLength(5);
    for (const key of calledKeys) {
      expect(key).toMatch(/^app:redis:/);
    }
  });

  it('namespaces the keys a Lua script is given, on both paths', async () => {
    // The script path is where the prefix was missing, and the missing part was
    // invisible until two deployments shared a redis and shared a rate limit:
    // every other command went through `key()`, `eval` passed its keys straight
    // to the client.
    const evalSha = vi.fn().mockResolvedValue([1, 0, 0, 0]);
    const evalScript = vi.fn().mockResolvedValue([1, 0, 0, 0]);
    const client = fakeClient({
      evalSha,
      eval: evalScript,
    });
    const { service } = build(() => client);

    await service.eval('return 1', ['throttle:login:127.0.0.1'], [1]);

    expect(evalSha.mock.calls[0][1].keys).toEqual([
      'app:redis:throttle:login:127.0.0.1',
    ]);

    // And the fallback, taken when redis has forgotten the digest — a restart.
    evalSha.mockRejectedValueOnce(new Error('NOSCRIPT'));
    await service.eval('return 1', ['throttle:login:127.0.0.1'], [1]);

    expect(evalScript.mock.calls[0][1].keys).toEqual([
      'app:redis:throttle:login:127.0.0.1',
    ]);
  });
});

describe('RedisClientService.setIfAbsent', () => {
  it('is true when the key was set, so this caller does the work', async () => {
    const client = fakeClient();
    const { service } = build(() => client);

    await expect(service.setIfAbsent('k', 'v', 60)).resolves.toBe(true);
  });

  it('is false when the key already existed', async () => {
    const client = fakeClient({ set: vi.fn().mockResolvedValue(null) });
    const { service } = build(() => client);

    await expect(service.setIfAbsent('k', 'v', 60)).resolves.toBe(false);
  });

  it('sets NX with the given ttl, which is what makes it a deduplication marker', async () => {
    const client = fakeClient();
    const { service } = build(() => client);

    await service.setIfAbsent('mail:a@x.com:welcome', 'v', 120);

    expect(client.set).toHaveBeenCalledWith(
      'app:redis:mail:a@x.com:welcome',
      'v',
      { NX: true, EX: 120 },
    );
  });

  it('rounds a sub-second ttl up to one, because EX 0 is an error', async () => {
    const client = fakeClient();
    const { service } = build(() => client);

    await service.setIfAbsent('k', 'v', 0);

    expect(client.set).toHaveBeenCalledWith('app:redis:k', 'v', {
      NX: true,
      EX: 1,
    });
  });

  it('rounds a fractional ttl up, so it never expires early', async () => {
    const client = fakeClient();
    const { service } = build(() => client);

    await service.setIfAbsent('k', 'v', 59.2);

    expect(client.set).toHaveBeenCalledWith('app:redis:k', 'v', {
      NX: true,
      EX: 60,
    });
  });
});

describe('RedisClientService.release', () => {
  it('is true when a key was removed', async () => {
    const { service } = build();

    await expect(service.release('k')).resolves.toBe(true);
  });

  it('is false when there was nothing to remove', async () => {
    const client = fakeClient({ del: vi.fn().mockResolvedValue(0) });
    const { service } = build(() => client);

    await expect(service.release('k')).resolves.toBe(false);
  });

  it('is false when redis could not be asked, not a throw', async () => {
    const { service } = build(() =>
      fakeClient({
        connect: vi.fn().mockRejectedValue(new Error('down')),
      }),
    );

    await expect(service.release('k')).resolves.toBe(false);
  });
});

describe('RedisClientService.pushToList', () => {
  it('trims the list, so a dead-letter cannot grow without bound', async () => {
    const client = fakeClient();
    const { service } = build(() => client);

    await service.pushToList('dead', 'entry', 100);

    expect(client.lPush).toHaveBeenCalledWith('app:redis:dead', 'entry');
    expect(client.lTrim).toHaveBeenCalledWith('app:redis:dead', 0, 99);
  });

  it('keeps at least one entry when the bound is nonsense', async () => {
    const client = fakeClient();
    const { service } = build(() => client);

    await service.pushToList('dead', 'entry', 0);

    expect(client.lTrim).toHaveBeenCalledWith('app:redis:dead', 0, 0);
  });

  it('is false when redis is down, so the caller can log it as a secondary loss', async () => {
    const { service } = build(() =>
      fakeClient({ connect: vi.fn().mockRejectedValue(new Error('down')) }),
    );

    await expect(service.pushToList('dead', 'entry')).resolves.toBe(false);
  });
});

describe('RedisClientService.listLength', () => {
  it('reads the length', async () => {
    const client = fakeClient({ lLen: vi.fn().mockResolvedValue(7) });
    const { service } = build(() => client);

    await expect(service.listLength('dead')).resolves.toBe(7);
  });

  it('is zero when redis is down, so a health check reads empty rather than failing', async () => {
    const { service } = build(() =>
      fakeClient({ connect: vi.fn().mockRejectedValue(new Error('down')) }),
    );

    await expect(service.listLength('dead')).resolves.toBe(0);
  });
});

describe('RedisClientService shutdown', () => {
  let service: RedisClientService;

  beforeEach(() => {
    const client = fakeClient();
    service = new RedisClientService(configService(), () => client);
  });

  it('quits an open client on shutdown', async () => {
    const client = fakeClient();
    const closing = new RedisClientService(configService(), () => client);
    await closing.setIfAbsent('k', 'v', 60);

    await closing.onModuleDestroy();

    expect(client.quit).toHaveBeenCalled();
  });

  it('refuses to reconnect after shutdown, so a late job cannot open a socket', async () => {
    await service.onModuleDestroy();

    await expect(service.getClient()).rejects.toThrow(/shut down/);
  });

  it('reports a command after shutdown as a miss rather than throwing', async () => {
    await service.onModuleDestroy();

    // The run() wrapper is what keeps this from becoming an unhandled rejection
    // in a job that was still in flight when the process was closing.
    await expect(service.setIfAbsent('k', 'v', 60)).resolves.toBeNull();
  });
});
