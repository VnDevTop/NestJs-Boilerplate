/**
 * The single list of packages that are only present when a feature is enabled.
 *
 * `src/` must never statically import any of these: a bare import is resolved
 * when the app is built, so a package that is not installed breaks the build
 * rather than disabling the feature. Load them with `loadOptional()` instead,
 * which resolves at runtime and returns `null` when nothing is installed.
 *
 * `optional-packages.spec.ts` fails if a static import of any of these ever
 * lands in the codebase.
 */
export const OPTIONAL_PACKAGES = {
  nodemailer: {
    feature: 'SMTP mail transport',
    specifier: 'nodemailer',
    envFlag: 'MAIL_TRANSPORT=smtp',
    install: 'npm install nodemailer',
  },
  ses: {
    feature: 'Amazon SES mail transport',
    specifier: '@aws-sdk/client-sesv2',
    envFlag: 'MAIL_TRANSPORT=ses',
    install: 'npm install @aws-sdk/client-sesv2',
  },
  sendgrid: {
    feature: 'SendGrid mail transport',
    specifier: '@sendgrid/mail',
    envFlag: 'MAIL_TRANSPORT=sendgrid',
    install: 'npm install @sendgrid/mail',
  },
  bullmq: {
    feature: 'BullMQ job queue',
    specifier: '@nestjs/bullmq',
    envFlag: 'QUEUE_ENABLED=true',
    install: 'npm install @nestjs/bullmq bullmq',
  },
} as const satisfies Record<string, OptionalPackage>;

export interface OptionalPackage {
  /** The capability the package unlocks, in user-facing terms. */
  feature: string;
  /** The bare specifier passed to `loadOptional()`. */
  specifier: string;
  /** The environment value that switches the feature on. */
  envFlag: string;
  /** The documented install command. */
  install: string;
}

export type OptionalPackageName = keyof typeof OPTIONAL_PACKAGES;

/**
 * Features the default profile serves with no package at all, because the
 * in-house implementation needs no package, only `HttpModule` from
 * `@nestjs/axios`, which the boilerplate already depends on.
 */
export const PACKAGE_FREE_INTEGRATIONS = {
  mailMemory: {
    feature: 'Development mail transport',
    envFlag: 'MAIL_TRANSPORT=memory',
    install: 'nothing, built in',
  },
  telegram: {
    feature: 'Telegram notifications',
    envFlag: 'TELEGRAM_ENABLED=true',
    install: 'nothing, built in',
  },
  slack: {
    feature: 'Slack notifications',
    envFlag: 'SLACK_ENABLED=true',
    install: 'nothing, built in',
  },
  discord: {
    feature: 'Discord notifications',
    envFlag: 'DISCORD_ENABLED=true',
    install: 'nothing, built in',
  },
  notificationEmail: {
    feature: 'Operator alerts by mail',
    envFlag: 'NOTIFICATION_EMAIL_ENABLED=true',
    install: 'nothing, built in',
  },
} as const;
