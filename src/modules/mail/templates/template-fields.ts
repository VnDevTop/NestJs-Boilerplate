import type {
  AccountLockedData,
  AccountPermanentlyLockedData,
  AccountUnlockedData,
  NewDeviceLoginData,
  NotificationData,
  PasswordChangedData,
  ResetPasswordData,
  VerifyEmailData,
  WelcomeData,
} from './mail.templates.js';
import type { TemplateName } from './template.registry.js';

/**
 * The fields each template may interpolate, and a sample value for each.
 *
 * ## Why this is written out rather than derived
 *
 * The data interfaces in `mail.templates.ts` are the type contract and they are
 * checked by the compiler. This is the *runtime* contract: it is what the admin route
 * hands an editor so the form can list the variables, and it is what the preview
 * renders sample values into.
 *
 * `satisfies` is what keeps the two from drifting. A field added to an interface
 * without a sample here is a compile error, and a sample for a field the interface
 * does not have is also one — so "the form lists the allowed fields" cannot quietly
 * become "the form lists the fields as they were when the form was written".
 */
export interface TemplateField {
  /** The name an editor writes between double braces. */
  readonly name: string;
  /** One line of prose, so the form says what the value is for. */
  readonly description: string;
  /**
   * A value the preview renders with.
   *
   * Deliberately obviously fake. The preview shows an operator what their edit looks
   * like, and a real address or a real reset token in that output is a credential
   * displayed to whoever is logged into the admin route.
   */
  readonly sample: string | number | null;
}

type FieldMap<T> = { readonly [K in keyof Required<T>]: TemplateField };

const field = (
  name: string,
  description: string,
  sample: string | number | null,
): TemplateField => ({ name, description, sample });

/**
 * Per-template field lists.
 *
 * Every template carries `appName`, and every one of them carries it for the same
 * reason: the shell puts it in the title and the footer says who sent the message. It
 * is not offered to an editor, because making it editable means an operator can
 * rename the product in one template and not the other nine, and a mail client
 * threading conversations would show two different senders.
 */
export const TEMPLATE_FIELDS = {
  welcome: {
    firstName: field('firstName', 'The name they registered with.', 'Ada'),
    appName: field('appName', 'The application name.', 'Boilerplate'),
  } satisfies FieldMap<WelcomeData>,

  'verify-email': {
    verificationUrl: field(
      'verificationUrl',
      'The one-time confirmation link.',
      'https://app.test/verify-email?token=sample-token',
    ),
    expiresInHours: field(
      'expiresInHours',
      'How long the link stays valid, in hours.',
      24,
    ),
    appName: field('appName', 'The application name.', 'Boilerplate'),
  } satisfies FieldMap<VerifyEmailData>,

  'reset-password': {
    resetUrl: field(
      'resetUrl',
      'The one-time password reset link.',
      'https://app.test/reset-password?token=sample-token',
    ),
    ip: field(
      'ip',
      'Where the request came from, so they can spot a stranger.',
      '203.0.113.7',
    ),
    expiresInMinutes: field(
      'expiresInMinutes',
      'How long the link stays valid, in minutes.',
      30,
    ),
    appName: field('appName', 'The application name.', 'Boilerplate'),
  } satisfies FieldMap<ResetPasswordData>,

  'password-changed': {
    ip: field('ip', 'Where the change was made from.', '203.0.113.7'),
    deviceLabel: field(
      'deviceLabel',
      'The device that made the change.',
      'Chrome on macOS',
    ),
    appName: field('appName', 'The application name.', 'Boilerplate'),
  } satisfies FieldMap<PasswordChangedData>,

  'new-device-login': {
    deviceLabel: field(
      'deviceLabel',
      'The device that signed in.',
      'Safari on iPhone',
    ),
    ip: field('ip', 'Where the sign-in came from.', '203.0.113.7'),
    time: field('time', 'When the sign-in happened.', '2026-01-31 09:15 UTC'),
    appName: field('appName', 'The application name.', 'Boilerplate'),
  } satisfies FieldMap<NewDeviceLoginData>,

  'account-locked': {
    reason: field('reason', 'Why the account was locked.', 'Too many attempts'),
    supportUrl: field(
      'supportUrl',
      'Where to ask a human.',
      'https://app.test/support',
    ),
    appName: field('appName', 'The application name.', 'Boilerplate'),
  } satisfies FieldMap<AccountLockedData>,

  'account-permanently-locked': {
    reason: field('reason', 'Why the account was locked.', 'Too many attempts'),
    unlockUrl: field(
      'unlockUrl',
      'The one-time unlock link, sent only to the confirmed address.',
      'https://app.test/unlock?token=sample-token',
    ),
    expiresInHours: field(
      'expiresInHours',
      'How long the unlock link stays valid, in hours.',
      48,
    ),
    failures: field(
      'failures',
      'How many attempts it took, when redis still remembers. Left empty when it does not, so the template says "too many" rather than guessing a number.',
      20,
    ),
    appName: field('appName', 'The application name.', 'Boilerplate'),
  } satisfies FieldMap<AccountPermanentlyLockedData>,

  'account-unlocked': {
    actor: field(
      'actor',
      'Who cleared the lock: "an administrator" or "you".',
      'an administrator',
    ),
    supportUrl: field(
      'supportUrl',
      'Where to ask a human.',
      'https://app.test/support',
    ),
    appName: field('appName', 'The application name.', 'Boilerplate'),
  } satisfies FieldMap<AccountUnlockedData>,

  notification: {
    headline: field(
      'headline',
      'The alert title, and also the subject line.',
      'Repeated failed sign-ins',
    ),
    body: field(
      'body',
      'The alert body. One line per bullet.',
      '203.0.113.7 tried to sign in 5 times\nThe account was locked',
    ),
    appName: field('appName', 'The application name.', 'Boilerplate'),
  } satisfies FieldMap<NotificationData>,
} satisfies { [K in TemplateName]: object };

/**
 * The fields an editor may use, with `appName` removed.
 *
 * `appName` is dropped because it is supplied by the application and used by the
 * shell, so it is not an editor's to change. See the note above.
 */
export function editableFields(name: TemplateName): TemplateField[] {
  return Object.values(TEMPLATE_FIELDS[name]).filter(
    (entry) => entry.name !== 'appName',
  );
}

/**
 * Sample data for a template, for the preview.
 *
 * Built from `TEMPLATE_FIELDS` rather than written out separately, so a field added
 * to one is automatically previewable through the other. A preview that silently
 * rendered an empty string for a new field would look like a broken template rather
 * than an incomplete fixture.
 */
export function sampleData(name: TemplateName): Record<string, unknown> {
  return Object.fromEntries(
    Object.values(TEMPLATE_FIELDS[name]).map((entry) => [
      entry.name,
      entry.sample,
    ]),
  );
}
