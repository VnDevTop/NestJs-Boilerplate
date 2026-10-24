import { describe, expect, it } from 'vitest';

import { isOptionalAvailable, loadOptional } from './optional.util.js';

describe('loadOptional', () => {
  it('returns the module for a package that is installed', () => {
    const loaded = loadOptional<{ createRequire: unknown }>('node:module');

    expect(loaded).not.toBeNull();
    expect(typeof loaded?.createRequire).toBe('function');
  });

  it('returns null for a package that is not installed', () => {
    expect(loadOptional('@nestjs-boilerplate/does-not-exist')).toBeNull();
  });

  it('returns null for a relative specifier that cannot be resolved', () => {
    expect(loadOptional('./nope.js')).toBeNull();
  });

  it('returns null for a broken specifier instead of throwing', () => {
    expect(loadOptional('')).toBeNull();
    expect(loadOptional('   ')).toBeNull();
  });

  it('unwraps a default export so esm and cjs callers agree', () => {
    const loaded = loadOptional<{ join?: unknown }>('node:path');

    expect(typeof loaded?.join).toBe('function');
  });
});

describe('isOptionalAvailable', () => {
  it('is true for an installed package', () => {
    expect(isOptionalAvailable('node:module')).toBe(true);
  });

  it('is false for a missing package', () => {
    expect(isOptionalAvailable('@nestjs-boilerplate/missing')).toBe(false);
  });
});
