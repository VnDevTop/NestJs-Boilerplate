import { Logger } from '@nestjs/common';

import { loadOptional } from '../../../core/optional/optional.util.js';
import type { MailConfig } from '../../../configs/mail.config.js';
import type {
  Nodemailer,
  NodemailerMessage,
  NodemailerOptions,
} from './provider.types.js';
import type {
  MailMessage,
  MailTransport,
  SendResult,
} from './transport.interface.js';

const logger = new Logger('SmtpMailTransport');

/** The npm specifier, as a string, because it must never be a static import. */
export const NODEMAILER_SPECIFIER = 'nodemailer';

/**
 * SMTP delivery over the optional `nodemailer`.
 *
 * The package is resolved by `loadOptional`, so this class exists whether or not
 * it is installed; the caller decides what a missing package means, which is
 * `isAvailable()` reporting false rather than a thrown error.
 */
export class SmtpMailTransport implements MailTransport {
  readonly name = 'smtp';

  private readonly client: Nodemailer | null;

  constructor(
    private readonly config: MailConfig,
    nodemailer: Nodemailer | null = loadOptional<Nodemailer>(
      NODEMAILER_SPECIFIER,
    ),
  ) {
    this.client = nodemailer;
  }

  /**
   * False when the package is not installed. The service falls back to another
   * transport rather than failing a request.
   */
  isAvailable(): boolean {
    return this.client !== null;
  }

  /**
   * Opens a connection and hangs up, without sending anything.
   *
   * nodemailer's own `verify`, which speaks EHLO and closes. Sending a message to
   * test the transport would put a message in a real recipient's inbox every time
   * a probe ran, and a provider rate limit would eventually refuse the probe and
   * take the real queue down with it.
   */
  async verify(): Promise<boolean> {
    if (this.client === null) {
      return false;
    }

    const transport = this.client.createTransport(this.options());

    try {
      return await (transport.verify?.() ?? Promise.resolve(true));
    } finally {
      transport.close?.();
    }
  }

  async send(message: MailMessage): Promise<SendResult> {
    if (this.client === null) {
      throw new Error(
        'nodemailer is not installed, so the smtp transport cannot send. ' +
          `Run: npm install ${NODEMAILER_SPECIFIER}`,
      );
    }

    const transport = this.client.createTransport(this.options());

    try {
      const info = await transport.sendMail(this.toProviderMessage(message));

      logger.log(
        `[mail:${message.mailId}] smtp accepted=${info.accepted.length} ` +
          `rejected=${info.rejected.length}`,
      );

      return {
        accepted: info.accepted,
        rejected: info.rejected,
        providerId: info.messageId,
      };
    } finally {
      // A pooled connection left open keeps the process alive and leaks a socket
      // per send. The pool is recreated per message because the config is static
      // and this class holds no per-send state.
      transport.close?.();
    }
  }

  private options(): NodemailerOptions {
    const { smtp, timeouts } = this.config;

    return {
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      connectionTimeout: timeouts.connection,
      socketTimeout: timeouts.socket,
      // Omitted entirely when unset, because nodemailer treats an empty auth
      // object as "authenticate with an empty user", which some servers answer
      // with a prompt rather than sending.
      auth:
        smtp.username && smtp.password
          ? { user: smtp.username, pass: smtp.password }
          : undefined,
    };
  }

  private toProviderMessage(message: MailMessage): NodemailerMessage {
    return {
      from: this.from(message),
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      replyTo: message.replyTo ?? this.config.replyTo,
      cc: message.cc,
      bcc: message.bcc,
      attachments: message.attachments?.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType,
      })),
    };
  }

  private from(message: MailMessage): string {
    const address = message.from ?? this.config.from;

    if (!address) {
      // Only reachable in development, since production validation requires
      // MAIL_FROM. Nodemailer would send this as `undefined <undefined>`.
      throw new Error('No from address configured, set MAIL_FROM');
    }

    return this.config.fromName
      ? `"${this.config.fromName}" <${address}>`
      : address;
  }
}
