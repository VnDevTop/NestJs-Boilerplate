import { describe, expect, it } from 'vitest';

import { MaintenanceModule } from '../maintenance/index.js';
import { QueueModule } from '../queue/index.js';
import { NotificationController } from './notification.controller.js';
import { NotificationEventsService } from './notification-events.service.js';
import { NotificationEventsModule } from './notification-events.module.js';
import { NotificationLogService } from './notification-log.service.js';
import { NotificationPreferencesService } from './notification-preferences.service.js';
import { NotificationModule } from './notification.module.js';
import { NotificationService } from './notification.service.js';

/**
 * The module graph is split in two on purpose, and the split is invisible from any
 * one file. `NotificationModule` has to sit *below* the queue because the queue's
 * router injects `NotificationProcessor`, which injects the delivery service; the
 * emit path and the preference routes have to sit *above* it because they enqueue.
 *
 * A cycle here does not fail a test — it fails at boot, in a deployment, and the error
 * Nest reports names a provider rather than the import that caused it. These
 * assertions are the cheap guard.
 */

const importsOf = (target: object): unknown[] =>
  Reflect.getMetadata('imports', target) as unknown[];

/** The class a metadata entry refers to, whether it is the class or a dynamic wrapper. */
const moduleOf = (entry: unknown): unknown =>
  (entry as { module?: unknown })?.module ?? entry;

describe('NotificationModule', () => {
  const imports = importsOf(NotificationModule);

  it('does not import the queue, because the queue imports it', () => {
    // The direction is the whole reason this module exists below the queue. Importing
    // the queue from here closes the loop and Nest resolves it to an unresolvable
    // dependency at boot.
    expect(imports.map(moduleOf)).not.toContain(QueueModule);
  });

  it('imports HttpCoreModule for the three webhook channels', () => {
    // Shared outbound HTTP client module with global timeout and request-id.
    const names = imports.map(
      (entry) =>
        (entry as { name?: string })?.name ??
        (moduleOf(entry) as { name?: string })?.name,
    );

    expect(names).toContain('HttpCoreModule');
  });

  it('imports the mail module for the channel that delegates to it', () => {
    const names = imports.map(
      (entry) =>
        (entry as { name?: string })?.name ??
        (moduleOf(entry) as { name?: string })?.name,
    );

    expect(names).toContain('MailModule');
  });

  it('declares no controllers, because the routes sit in the module above', () => {
    // Placing them here would make a lower module depend on a request, which is the
    // wrong direction for the thing that delivery needs.
    expect(
      (Reflect.getMetadata('controllers', NotificationModule) as unknown[]) ??
        [],
    ).toEqual([]);
  });

  it('exports the delivery service and the preferences service', () => {
    // The exports are the contract: `MaintenanceModule` imports this for the anomaly
    // report, and `NotificationEventsModule` imports it for the routes. Asserted
    // against the classes rather than their names, because that is what the metadata
    // actually holds and a name comparison would pass on any string.
    const exports = Reflect.getMetadata(
      'exports',
      NotificationModule,
    ) as unknown[];

    expect(exports).toContain(NotificationService);
    expect(exports).toContain(NotificationPreferencesService);
    expect(exports).toContain(NotificationLogService);
  });
});

describe('NotificationEventsModule', () => {
  const imports = importsOf(NotificationEventsModule);

  it('imports the queue, because the emit path enqueues', () => {
    expect(imports.map(moduleOf)).toContain(QueueModule);
  });

  it('imports the delivery module below it, so the two halves meet above', () => {
    expect(imports.map(moduleOf)).toContain(NotificationModule);
  });

  it('holds the emit service and the preference routes', () => {
    const providers = Reflect.getMetadata(
      'providers',
      NotificationEventsModule,
    ) as unknown[];
    const controllers = Reflect.getMetadata(
      'controllers',
      NotificationEventsModule,
    ) as unknown[];

    expect(providers).toContain(NotificationEventsService);
    expect(controllers).toContain(NotificationController);
  });

  it('exports the emit service, which is what a business module imports', () => {
    expect(
      Reflect.getMetadata('exports', NotificationEventsModule) as unknown[],
    ).toContain(NotificationEventsService);
  });
});

describe('MaintenanceModule', () => {
  it('imports the delivery module but still not the queue', () => {
    // Both directions are true and both matter: the retention processor reports an
    // anomaly through the delivery service directly, because it is already running
    // inside a job and there is no request to keep off the critical path.
    const imports = importsOf(MaintenanceModule).map(moduleOf);

    expect(imports).toContain(NotificationModule);
    expect(imports).not.toContain(QueueModule);
  });
});
