import {
  accountLockedTemplate,
  newDeviceLoginTemplate,
  notificationTemplate,
  passwordChangedTemplate,
  resetPasswordTemplate,
  verifyEmailTemplate,
  welcomeTemplate,
  type AccountLockedData,
  type NewDeviceLoginData,
  type NotificationData,
  type PasswordChangedData,
  type ResetPasswordData,
  type VerifyEmailData,
  type WelcomeData,
} from './mail.templates.js';

/**
 * A template is a subject and a render function, nothing more.
 *
 * The data type is the whole contract. A caller that passes a user entity is a
 * type error, which is why no signature here mentions `User`: a template that
 * *can* read `user.password` is one refactor away from mailing a credential.
 */
export interface MailTemplate<TData> {
  /** Config-independent name, used in log lines and in the `mail_logs` row. */
  readonly name: string;
  subject(data: TData): string;
  /** Both parts at once, so a template cannot forget the plain-text one. */
  render(data: TData): { text: string; html: string };
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

/** What each template name expects. */
export interface TemplateDataByName {
  welcome: WelcomeData;
  'verify-email': VerifyEmailData;
  'reset-password': ResetPasswordData;
  'password-changed': PasswordChangedData;
  'new-device-login': NewDeviceLoginData;
  'account-locked': AccountLockedData;
  /**
   * The operator-alert template from Phase 18. It is here rather than in the
   * notification module because it is a mail: same layout, same escaping, same
   * transport, and a second template system would be two renderers to keep in step.
   */
  notification: NotificationData;
}

const registry: {
  [K in keyof TemplateDataByName]: MailTemplate<TemplateDataByName[K]>;
} = {
  welcome: welcomeTemplate,
  'verify-email': verifyEmailTemplate,
  'reset-password': resetPasswordTemplate,
  'password-changed': passwordChangedTemplate,
  'new-device-login': newDeviceLoginTemplate,
  'account-locked': accountLockedTemplate,
  notification: notificationTemplate,
};

export type TemplateName = keyof TemplateDataByName;

export const TEMPLATE_NAMES = Object.keys(registry) as TemplateName[];

export function getTemplate<TName extends TemplateName>(
  name: TName,
): MailTemplate<TemplateDataByName[TName]> {
  return registry[name];
}

export function hasTemplate(name: string): name is TemplateName {
  return name in registry;
}

/**
 * Renders a template by name.
 *
 * The lookup is a cast because the name is already narrowed by the generic, and
 * the `!registry[name]` branch is a programming error guard rather than a
 * runtime condition: every call site passes a literal, and the type refuses the
 * rest.
 */
export function renderTemplate<TName extends TemplateName>(
  name: TName,
  data: TemplateDataByName[TName],
): RenderedMail {
  const template = registry[name] as
    MailTemplate<TemplateDataByName[TName]> | undefined;

  if (!template) {
    throw new Error(
      `Unknown mail template "${name}", expected one of ${TEMPLATE_NAMES.join(', ')}`,
    );
  }

  const { text, html } = template.render(data);

  return { subject: template.subject(data), text, html };
}
