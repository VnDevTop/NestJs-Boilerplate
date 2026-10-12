/**
 * The provider client shapes these transports drive.
 *
 * Declared here rather than imported from `nodemailer`, `@aws-sdk/client-sesv2`
 * or `@sendgrid/mail`. A type-only `typeof import('nodemailer')` is still
 * resolved by `tsc`, so a clone with no provider package installed would fail to
 * typecheck, which is the build-time failure this project avoids. Each shape
 * mirrors the options object its client expects and is passed straight through.
 *
 * Only the members these transports use are declared. A provider that adds a
 * field is not a type error here, which is deliberate: pinning the full client
 * surface would couple the boilerplate to a package version.
 */

/** Mirrors `SMTPTransport.Options`, the object nodemailer's `createTransport` takes. */
export interface NodemailerOptions {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
  connectionTimeout: number;
  socketTimeout: number;
}

/** The `sendMail` input this transport builds, after nodemailer has seen it. */
export interface NodemailerMessage {
  from: string;
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  attachments?: {
    filename: string;
    content: string | Buffer;
    contentType?: string;
  }[];
}

/**
 * The subset of `SMTPTransport` this transport calls.
 *
 * `verify` is nodemailer's own readiness call: it opens a connection, speaks
 * EHLO and closes, without sending anything or consuming a quota. That is exactly
 * what a health check needs and exactly what a synthetic send is not.
 */
export interface NodemailerTransport {
  verify?(): Promise<boolean>;
  sendMail(message: NodemailerMessage): Promise<{
    messageId: string;
    accepted: string[];
    rejected: string[];
  }>;
  close?(): void;
}

/** The subset of `nodemailer` this transport calls. */
export interface Nodemailer {
  createTransport(options: NodemailerOptions): NodemailerTransport;
}

/** Mirrors the client options the SES v2 client is constructed with. */
export interface SesClientOptions {
  region?: string;
}

/** The `SendEmailCommand` input this transport builds. */
export interface SesSendEmailInput {
  FromEmailAddress?: string;
  Destination?: {
    ToAddresses?: string[];
    CcAddresses?: string[];
    BccAddresses?: string[];
  };
  ReplyToAddresses?: string[];
  Content?: {
    Simple: {
      Subject?: { Data?: string };
      Body?: { Text?: { Data?: string }; Html?: { Data?: string } };
    };
  };
}

/** The subset of the SES client this transport calls. */
export interface SesClient {
  send(input: SesSendEmailInput): Promise<{ MessageId?: string }>;
  destroy?(): void;
}

/** The subset of the SES module this transport constructs a client from. */
export interface SesModule {
  SESv2Client: new (options: SesClientOptions) => SesClient;
}

/** Mirrors the message object `@sendgrid/mail`'s `send` takes. */
export interface SendgridMessage {
  to: string | string[];
  from: { email: string; name?: string };
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  attachments?: { filename: string; content: string | Buffer; type?: string }[];
}

/** The subset of `@sendgrid/mail` this transport calls. */
export interface SendgridMail {
  setApiKey(apiKey: string): void;
  send(message: SendgridMessage): Promise<{ statusCode?: number }[]>;
}
