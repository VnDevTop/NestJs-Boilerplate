import { registerAs } from '@nestjs/config';
import type { MailerOptions } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/dist/adapters/handlebars.adapter.js';
import { join } from 'path';

export interface MailConfig extends MailerOptions {}

export const mailConfig = registerAs<MailConfig>(
  'mail',
  (): MailConfig => {
    const host = process.env.MAIL_HOST;
    const port = Number(process.env.MAIL_PORT ?? 587);
    const user = process.env.MAIL_USER;
    const password = process.env.MAIL_PASSWORD;
    const from = process.env.MAIL_FROM ?? 'no-reply@example.com';
    const secure = process.env.MAIL_SECURE === 'true';
    return {
      transport: host
        ? {
            host,
            port,
            secure,
            auth: user ? { user, pass: password } : undefined,
          }
        : undefined,
      defaults: { from },
      template: {
        dir: join(process.cwd(), 'src', 'mail', 'templates'),
        adapter: new HandlebarsAdapter(),
        options: { strict: true },
      },
    };
  },
);