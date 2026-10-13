/**
 * The whole outbound mail surface.
 *
 * A transport is the only thing that knows how bytes leave the process. The
 * service above it never sees a provider client, so swapping SMTP for SES is a
 * configuration change and a new class, not a change to the code that sends.
 */

export interface MailAttachment {
  filename: string;
  /** Text is the common case; a Buffer is here for a generated PDF or similar. */
  content: string | Buffer;
  contentType?: string;
}

export interface MailMessage {
  to: string | string[];
  subject: string;
  /** Plain-text part. Always present: it is the one clients fall back to. */
  text: string;
  /** HTML part, for clients that render it. */
  html?: string;
  from?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  attachments?: MailAttachment[];
  /**
   * Correlation id, generated once per message and carried on the log line, the
   * provider call and the eventual `mail_logs` row. It is what makes "the user
   * says they got nothing" answerable.
   */
  mailId: string;
  /**
   * Template name, for the record. Not used for rendering here, since the
   * service renders before calling a transport.
   */
  template?: string;
}

export interface SendResult {
  /** Recipients the provider accepted. */
  accepted: string[];
  /** Recipients the provider refused, which is not an error by itself. */
  rejected: string[];
  /** Provider's own id, when it gives one. Absent for the memory transport. */
  providerId?: string;
}

export interface MailTransport {
  /** Config name, reported by the health check so an operator can see it. */
  readonly name: string;
  send(message: MailMessage): Promise<SendResult>;

  /**
   * Checks the transport is usable, without sending anything.
   *
   * **Optional on purpose.** The memory transport cannot be verified — there is
   * nothing out there to reach — and a transport whose provider has no cheap
   * readiness call is better off omitting this than shipping a probe that sends
   * mail. The health check reports `verified: false` when it is absent rather than
   * treating the absence as a failure.
   *
   * The contract is narrow for a reason: this is a health check, not a
   * connectivity test. It must not send a message, must not consume a provider
   * quota in a loop, and must resolve rather than hang when the provider is down.
   */
  verify?(): Promise<boolean>;
}

/**
 * True when a provider rejected the message for a reason retrying cannot fix.
 *
 * A 4xx means the request itself is wrong: a bad address, a revoked credential,
 * a suppressed recipient. Retrying it wastes the retry budget and delays the
 * dead-letter entry that would tell an operator something is misconfigured.
 * Timeouts, 5xx and connection errors are the retryable ones.
 */
export function isPermanentRejection(error: unknown): boolean {
  const status = extractStatusCode(error);

  return status !== null && status >= 400 && status < 500;
}

/**
 * The http status an error carries, across the shapes a client uses, or `null`
 * when there is none.
 *
 * Exported because the reason a send failed is only available while the error is
 * in hand, and the caller that decides whether to retry is not the one that
 * caught it.
 */
export function extractStatusCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  for (const key of ['status', 'statusCode', 'code']) {
    const value = (error as Record<string, unknown>)[key];

    if (typeof value === 'number' && value >= 100 && value < 600) {
      return value;
    }
  }

  return null;
}
