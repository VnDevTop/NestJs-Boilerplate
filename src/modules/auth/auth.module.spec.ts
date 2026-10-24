import { ThrottlerModule } from '@nestjs/throttler';

import { describe, expect, it } from 'vitest';

import { AuthModule } from './auth.module.js';

/**
 * The guard applied to the mail routes needs the throttler options and storage,
 * and `ThrottlerModule` is not global.
 *
 * Relying on `app.module` having registered it works right up until something
 * builds this module without the whole application, and the failure then reads
 * as a missing provider rather than a missing import. Asserting the import is
 * the direct way to keep that from regressing: compiling the module here would
 * need a live DataSource for the repositories, which is a different test.
 */
describe('AuthModule imports', () => {
  const imports = Reflect.getMetadata('imports', AuthModule) as unknown[];

  it('imports a throttler module of its own', () => {
    // The dynamic module `forRootAsync` returns, not the bare class, so both
    // shapes are accepted.
    const hasThrottler = imports.some(
      (entry) =>
        entry === ThrottlerModule ||
        (entry as { module?: unknown })?.module === ThrottlerModule,
    );

    expect(hasThrottler).toBe(true);
  });

  it('still imports the modules it always did', () => {
    const names = imports.map(
      (entry) =>
        (entry as { name?: string })?.name ??
        (entry as { module?: { name?: string } })?.module?.name,
    );

    expect(names).toContain('TypeOrmModule');
    expect(names).toContain('PassportModule');
    expect(names).toContain('MailModule');
    expect(names).toContain('HttpCoreModule');
  });
});
