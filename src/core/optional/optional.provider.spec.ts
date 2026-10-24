import { Test } from '@nestjs/testing';

import { describe, expect, it } from 'vitest';

import {
  createOptionalProvider,
  createOptionalProviders,
} from './optional.provider.js';

type MailModule = { createTransport: () => string };

const MISSING = '@nestjs-boilerplate/not-installed';
const PRESENT = 'node:path';

function resolve<T>(
  provider: ReturnType<typeof createOptionalProvider<T>>,
): T | null {
  const factory = provider.useFactory as () => T | null;
  return factory();
}

describe('createOptionalProvider', () => {
  it('resolves to null when the package is missing', () => {
    expect(resolve(createOptionalProvider(MISSING))).toBeNull();
  });

  it('resolves to the module when the package is installed', () => {
    const resolved = resolve<{ join: unknown }>(
      createOptionalProvider(PRESENT),
    );

    expect(resolved).not.toBeNull();
    expect(typeof resolved?.join).toBe('function');
  });

  it('passes the loaded module through the use hook', () => {
    const resolved = resolve<MailModule>(
      createOptionalProvider<MailModule>(PRESENT, {
        use: () => ({ createTransport: () => 'from-hook' }),
      }),
    );

    expect(resolved?.createTransport()).toBe('from-hook');
  });

  it('does not call the use hook when the package is missing', () => {
    let called = false;

    const resolved = resolve(
      createOptionalProvider(MISSING, {
        use: () => {
          called = true;
          return {};
        },
      }),
    );

    expect(resolved).toBeNull();
    expect(called).toBe(false);
  });

  it('resolves to null when the feature flag is off, without touching disk', () => {
    const resolved = resolve(
      createOptionalProvider(PRESENT, { isEnabled: () => false }),
    );

    expect(resolved).toBeNull();
  });

  it('resolves the module when the feature flag is on', () => {
    const resolved = resolve(
      createOptionalProvider(PRESENT, { isEnabled: () => true }),
    );

    expect(resolved).not.toBeNull();
  });

  it('injects null into a consumer rather than failing to build', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [createOptionalProvider(MISSING)],
    }).compile();

    expect(moduleRef.get(MISSING)).toBeNull();
    await moduleRef.close();
  });
});

describe('createOptionalProviders', () => {
  it('registers every specifier, null included', () => {
    const providers = createOptionalProviders([PRESENT, MISSING]);
    const values = providers.map((provider) =>
      (provider as { useFactory: () => unknown }).useFactory(),
    );

    expect(values).toHaveLength(2);
    expect(values[1]).toBeNull();
  });
});
