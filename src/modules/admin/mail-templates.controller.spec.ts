import { beforeEach, describe, expect, it } from 'vitest';

import { ConflictException, NotFoundException } from '@nestjs/common';

import type { EmailTemplate } from '../mail/entities/email-template.entity.js';
import {
  DEFAULT_LOCALE,
  MailTemplateStore,
  type ResolvedTemplate,
} from '../mail/mail-template.store.js';
import { AdminMailTemplatesController } from './mail-templates.controller.js';

/**
 * The admin surface, with the store faked.
 *
 * Faked rather than real because these assertions are about the *route* — which
 * permission, which status, what the operator is told — and not about rendering.
 * Rendering is `mail-template.store.spec.ts` and `handlebars.spec.ts`; using a real
 * store here would test the same code twice and neither test would notice if the
 * controller stopped passing `updatedBy`.
 */

class FakeStore {
  rows = new Map<string, EmailTemplate>();
  readonly saved: unknown[] = [];
  readonly resets: string[] = [];
  version: number | null = null;

  private key(name: string, locale: string): string {
    return `${name}:${locale}`;
  }

  stored = async (
    name: string,
    locale = DEFAULT_LOCALE,
  ): Promise<EmailTemplate | null> =>
    this.rows.get(this.key(name, locale)) ?? null;

  resolve = async (
    name: string,
    locale = DEFAULT_LOCALE,
  ): Promise<ResolvedTemplate> => {
    const row = this.rows.get(this.key(name, locale));

    return row
      ? {
          subject: row.subject,
          text: row.text,
          html: row.html,
          origin: 'database',
          version: row.version,
        }
      : {
          subject: 'shipped subject',
          text: 'shipped text',
          html: '<p>shipped</p>',
          origin: 'file',
          version: null,
        };
  };

  save = async (input: {
    name: string;
    locale: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<EmailTemplate> => {
    this.saved.push(input);

    const row = {
      id: 'row-1',
      name: input.name,
      locale: input.locale,
      subject: input.subject,
      text: input.text,
      html: input.html,
      version: 2,
      updatedBy: null,
      updatedAt: new Date('2026-01-31T09:15:00Z'),
    } as EmailTemplate;

    this.rows.set(this.key(input.name, input.locale), row);

    return row;
  };

  reset = async (name: string): Promise<void> => {
    this.resets.push(name);
    this.rows.delete(this.key(name, DEFAULT_LOCALE));
  };

  renderPreview = async (
    name: string,
    source: { subject: string; text: string; html: string },
  ): Promise<{ subject: string; text: string; html: string }> => ({
    subject: source.subject,
    text: source.text,
    html: source.html,
  });

  history = async () => [];
}

const BODY = {
  subject: 'Edited subject',
  text: 'Edited text',
  html: '<p>Edited body</p>',
};

describe('AdminMailTemplatesController', () => {
  let store: FakeStore;
  let controller: AdminMailTemplatesController;

  beforeEach(() => {
    store = new FakeStore();
    controller = new AdminMailTemplatesController(
      store as unknown as MailTemplateStore,
    );
  });

  describe('read', () => {
    it('lists every template, shipped ones included', async () => {
      const list = await controller.list();

      // An operator choosing what to edit needs to see what exists, not only what
      // somebody has already touched.
      expect(list.length).toBeGreaterThan(5);
      expect(list.every((entry) => entry.origin === 'file')).toBe(true);
    });

    it('reports a stored template as coming from the database', async () => {
      store.rows.set('welcome:en', {
        name: 'welcome',
        locale: 'en',
        subject: 'S',
        text: 'T',
        html: '<p>H</p>',
        version: 4,
        updatedBy: 'someone',
        updatedAt: new Date('2026-01-31T09:15:00Z'),
      } as EmailTemplate);

      const read = await controller.read('welcome', 'en');

      expect(read.origin).toBe('database');
      expect(read.version).toBe(4);
      expect(read.updatedBy).toBe('someone');
    });

    it('offers the fields an editor may use, without appName', async () => {
      const read = await controller.read('welcome', 'en');
      const names = (read.fields ?? []).map((field) => field.name);

      // `appName` is supplied by the application and used by the shell. Offering it
      // would let an operator rename the product in one template and not the other
      // nine, and a mail client threading conversations would show two senders.
      expect(names).toContain('firstName');
      expect(names).not.toContain('appName');
    });

    it('refuses a name that is not a template', async () => {
      // A 404 rather than a 400: from the caller's side it is a missing resource,
      // and a route that accepted an arbitrary name would let a caller write a
      // template nothing ever sends.
      await expect(controller.read('not-a-template', 'en')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('write', () => {
    it('stores the edit and reports the new version', async () => {
      const saved = await controller.replace('welcome', BODY, 'en');

      expect(saved.origin).toBe('database');
      expect(saved.version).toBe(2);
      expect(store.saved).toHaveLength(1);
    });

    it('refuses an edit based on a version that has moved on', async () => {
      store.rows.set('welcome:en', {
        name: 'welcome',
        locale: 'en',
        subject: 'S',
        text: 'T',
        html: '<p>H</p>',
        version: 5,
        updatedBy: null,
        updatedAt: new Date(),
      } as EmailTemplate);

      // Two operators editing a password reset email at once is the normal case in a
      // team. Without this the second save silently overwrites the first one's
      // wording, which is the failure version history exists to make recoverable.
      await expect(
        controller.replace('welcome', { ...BODY, version: 2 }, 'en'),
      ).rejects.toThrow(ConflictException);
    });

    it('refuses an edit against a version that no longer exists', async () => {
      // No row at all but a version was sent: the template was reset to the shipped
      // file, and the edit the operator was looking at is gone.
      await expect(
        controller.replace('welcome', { ...BODY, version: 4 }, 'en'),
      ).rejects.toThrow(ConflictException);
    });

    it('accepts an edit whose version matches', async () => {
      store.rows.set('welcome:en', {
        name: 'welcome',
        locale: 'en',
        subject: 'S',
        text: 'T',
        html: '<p>H</p>',
        version: 2,
        updatedBy: null,
        updatedAt: new Date(),
      } as EmailTemplate);

      await expect(
        controller.replace('welcome', { ...BODY, version: 2 }, 'en'),
      ).resolves.toMatchObject({ version: 2 });
    });

    it('refuses a name that is not a template', async () => {
      await expect(controller.replace('nope', BODY, 'en')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('reset', () => {
    it('goes back to the shipped file', async () => {
      store.rows.set('welcome:en', {
        name: 'welcome',
        locale: 'en',
        subject: 'S',
        text: 'T',
        html: '<p>H</p>',
        version: 3,
        updatedBy: null,
        updatedAt: new Date(),
      } as EmailTemplate);

      const reset = await controller.reset('welcome', 'en');

      expect(reset.origin).toBe('file');
      expect(store.resets).toContain('welcome');
    });

    it('refuses when the template is already the shipped one', async () => {
      // Nothing to undo, and a 404 is what an operator editing a form that is
      // already showing the shipped wording needs to be told.
      await expect(controller.reset('welcome', 'en')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('preview', () => {
    it('renders without storing anything', async () => {
      const preview = await controller.preview({ ...BODY, name: 'welcome' });

      expect(preview.rendered.subject).toBe('Edited subject');
      expect(store.saved).toHaveLength(0);
    });

    it('renders against the sample data for that template', async () => {
      const preview = await controller.preview({
        subject: 'Hello {{firstName}}',
        text: 'Hello {{firstName}}',
        html: '<p>{{firstName}}</p>',
        name: 'welcome',
      });

      // The contract is what makes the preview useful: an editor sees what the field
      // resolves to rather than having to know the application.
      expect(preview.data).toHaveProperty('firstName');
    });

    it('refuses a name that is not a template', async () => {
      await expect(
        controller.preview({ ...BODY, name: 'nope' }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
