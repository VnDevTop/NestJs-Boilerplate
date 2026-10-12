import { actionLink, escapeHtml, layout } from './layout.js';
import type { MailTemplate } from './template.registry.js';

/**
 * The templates.
 *
 * Each one takes exactly the fields it interpolates and nothing else. No
 * template receives a user entity: a template that can read `user.password` or
 * `user.role` is one refactor away from putting a secret in an email, and the
 * type is what stops that rather than a code review.
 */

export interface WelcomeData {
  firstName: string;
  appName: string;
}

export const welcomeTemplate: MailTemplate<WelcomeData> = {
  name: 'welcome',
  subject: ({ appName }) => `Welcome to ${appName}`,
  render: (data) => {
    const greeting = data.firstName ? `Hello ${data.firstName},` : 'Hello,';

    return layout({
      appName: data.appName,
      text: `${greeting}\n\nYour ${data.appName} account is ready.\n\nYou can sign in with the email address you registered with.`,
      html: `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${escapeHtml(greeting)}</p>
<p style="margin:0;font-size:15px;line-height:1.6;">Your account is ready. You can sign in with the email address you registered with.</p>`,
    });
  },
};

export interface VerifyEmailData {
  verificationUrl: string;
  expiresInHours: number;
  appName: string;
}

export const verifyEmailTemplate: MailTemplate<VerifyEmailData> = {
  name: 'verify-email',
  subject: ({ appName }) => `Verify your ${appName} email address`,
  render: (data) => {
    const link = actionLink(data.verificationUrl, 'Verify email address');

    return layout({
      appName: data.appName,
      text: `Confirm this address to finish setting up your account.\n\n${link.text}\n\nThis link expires in ${data.expiresInHours} hours and works once. If you did not create an account, ignore this message.`,
      html: `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Confirm this address to finish setting up your account.</p>
${link.html}
<p style="margin:24px 0 0;font-size:13px;color:#52606d;">This link expires in ${escapeHtml(String(data.expiresInHours))} hours and works once. If you did not create an account, you can ignore this message.</p>`,
    });
  },
};

export interface ResetPasswordData {
  resetUrl: string;
  /** The address the request came from, so a user can spot a stranger's request. */
  ip: string;
  expiresInMinutes: number;
  appName: string;
}

export const resetPasswordTemplate: MailTemplate<ResetPasswordData> = {
  name: 'reset-password',
  subject: ({ appName }) => `Reset your ${appName} password`,
  render: (data) => {
    const link = actionLink(data.resetUrl, 'Choose a new password');

    return layout({
      appName: data.appName,
      text: `Someone asked to reset the password for this account from ${data.ip}.\n\n${link.text}\n\nThis link expires in ${data.expiresInMinutes} minutes and works once. If this was not you, no action is needed and your password has not changed.`,
      html: `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Someone asked to reset the password for this account from <strong>${escapeHtml(data.ip)}</strong>.</p>
${link.html}
<p style="margin:24px 0 0;font-size:13px;color:#52606d;">This link expires in ${escapeHtml(String(data.expiresInMinutes))} minutes and works once. If this was not you, no action is needed and your password has not changed.</p>`,
    });
  },
};

export interface PasswordChangedData {
  ip: string;
  deviceLabel: string;
  appName: string;
}

export const passwordChangedTemplate: MailTemplate<PasswordChangedData> = {
  name: 'password-changed',
  subject: ({ appName }) => `Your ${appName} password was changed`,
  render: (data) => {
    const notice = `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Your password was changed. Every other session has been signed out.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.8;color:#3e4c59;">
<tr><td style="padding:0 12px 0 0;color:#616e7c;">From</td><td>${escapeHtml(data.ip)}</td></tr>
<tr><td style="padding:0 12px 0 0;color:#616e7c;">Device</td><td>${escapeHtml(data.deviceLabel)}</td></tr>
</table>
<p style="margin:24px 0 0;font-size:13px;color:#52606d;">If this was not you, reset your password now and contact support.</p>`;

    return layout({
      appName: data.appName,
      text: `Your password was changed. Every other session has been signed out.\n\nFrom: ${data.ip}\nDevice: ${data.deviceLabel}\n\nIf this was not you, reset your password now and contact support.`,
      html: notice,
    });
  },
};

export interface NewDeviceLoginData {
  deviceLabel: string;
  ip: string;
  time: string;
  appName: string;
}

export const newDeviceLoginTemplate: MailTemplate<NewDeviceLoginData> = {
  name: 'new-device-login',
  subject: ({ appName }) => `New sign-in to your ${appName} account`,
  render: (data) => {
    const details = `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">A new device signed in to your account.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.8;color:#3e4c59;">
<tr><td style="padding:0 12px 0 0;color:#616e7c;">Device</td><td>${escapeHtml(data.deviceLabel)}</td></tr>
<tr><td style="padding:0 12px 0 0;color:#616e7c;">Location</td><td>${escapeHtml(data.ip)}</td></tr>
<tr><td style="padding:0 12px 0 0;color:#616e7c;">Time</td><td>${escapeHtml(data.time)}</td></tr>
</table>
<p style="margin:24px 0 0;font-size:13px;color:#52606d;">If this was not you, change your password immediately.</p>`;

    return layout({
      appName: data.appName,
      text: `A new device signed in to your account.\n\nDevice: ${data.deviceLabel}\nLocation: ${data.ip}\nTime: ${data.time}\n\nIf this was not you, change your password immediately.`,
      html: details,
    });
  },
};

export interface AccountPermanentlyLockedData {
  reason: string;
  /** Where the owner goes to have the lock cleared without an operator. */
  unlockUrl: string;
  expiresInHours: number;
  /**
   * How many failures it took, so the owner can see it was not their keystroke.
   *
   * Null when the lock is older than redis's memory of it. The number is never
   * guessed at that point, so the sentence falls back to "too many" rather than to
   * a count that could be wrong.
   */
  failures: number | null;
  appName: string;
}

/**
 * The permanent lockout, Phase 19.
 *
 * A separate template from `account-locked` because the two are different facts
 * with different recoveries. That one is a temporary block with a clock on it and
 * nothing to click; this one needs an action, so it carries the link. Sharing a
 * template would mean one of the two carried a button that did nothing useful.
 *
 * The button text says who clicked it. The reader of this message is either the
 * person who locked themselves out or somebody who has their inbox — and only the
 * second can use it. A mail that says "your account is locked" and gives a link
 * teaches people that these mails are sent to attackers too.
 */
export const accountPermanentlyLockedTemplate: MailTemplate<AccountPermanentlyLockedData> =
  {
    name: 'account-permanently-locked',
    subject: ({ appName }) => `Your ${appName} account has been locked`,
    render: (data) => {
      const link = actionLink(data.unlockUrl, 'Unlock my account');
      const count = data.failures;
      const headline =
        count === null
          ? 'Your account has been locked after too many failed sign-in attempts.'
          : `Your account has been locked after ${count} failed sign-in attempts.`;
      const advice =
        count === null
          ? 'If these attempts were not yours, change your password once you are back in — somebody may have been guessing it.'
          : `If you did not try to sign in ${count} times, change your password once you are back in — somebody may have been guessing it.`;

      return layout({
        appName: data.appName,
        text: `${headline} Every session has been signed out.\n\nReason: ${data.reason}\n\n${link.text}\n\nThis link expires in ${data.expiresInHours} hours and works once. ${advice}`,
        html: `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${escapeHtml(headline)} Every session has been signed out.</p>
<p style="margin:0 0 4px;font-size:14px;color:#616e7c;">Reason</p>
<p style="margin:0 0 20px;font-size:15px;line-height:1.6;">${escapeHtml(data.reason)}</p>
${link.html}
<p style="margin:24px 0 0;font-size:13px;color:#52606d;">This link expires in ${escapeHtml(String(data.expiresInHours))} hours and works once. Nobody else can use it, because it is sent only to the confirmed address on the account. ${escapeHtml(advice)}</p>`,
      });
    },
  };

export interface AccountUnlockedData {
  /** "an administrator" or "you", so the sentence about who did it reads right. */
  actor: string;
  supportUrl: string;
  appName: string;
}

export const accountUnlockedTemplate: MailTemplate<AccountUnlockedData> = {
  name: 'account-unlocked',
  subject: ({ appName }) => `Your ${appName} account is unlocked again`,
  render: (data) => {
    const link = actionLink(data.supportUrl, 'Contact support');

    return layout({
      appName: data.appName,
      text: `Your account has been unlocked by ${data.actor}.\n\nYou can sign in again. If you were not the one who signed in, change your password and review your active sessions.\n\n${link.text}`,
      html: `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Your account has been unlocked by ${escapeHtml(data.actor)}.</p>
<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">You can sign in again. If you were not the one who signed in, change your password and review your active sessions.</p>
${link.html}`,
    });
  },
};

/**
 * The operator-alert template, added by Phase 18.
 *
 * One template rather than one per notification event, because these events are not
 * transactional mail: they carry no link, no per-recipient wording and no call to
 * action. What they carry is a headline the event rendered and a body it rendered,
 * and a registry entry per event would be six ways to get the escaping wrong in a
 * message that goes to an operator rather than to a user.
 *
 * The subject is the headline rather than a fixed string, because an operator
 * triages a mailbox by subject line and "Security alert" six times a day tells them
 * nothing about which one to open.
 */
export interface NotificationData {
  headline: string;
  body: string;
  appName: string;
}

export const notificationTemplate: MailTemplate<NotificationData> = {
  name: 'notification',
  subject: ({ headline }) => headline,
  render: (data) => {
    const text = data.body
      .split('\n')
      .map((line) => (line === '' ? '' : `• ${line}`))
      .join('\n');

    const html = `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;"><strong>${escapeHtml(
      data.headline,
    )}</strong></p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.8;color:#3e4c59;">${data.body
      .split('\n')
      .filter((line) => line !== '')
      .map(
        (line) =>
          `<tr><td style="padding:1px 10px 1px 0;color:#9aa5b1;">•</td><td>${escapeHtml(
            line,
          )}</td></tr>`,
      )
      .join('')}</table>
<p style="margin:24px 0 0;font-size:13px;color:#52606d;">This is an operator alert, not a message for a user.</p>`;

    return layout({ appName: data.appName, text, html });
  },
};

export interface AccountLockedData {
  reason: string;
  supportUrl: string;
  appName: string;
}

export const accountLockedTemplate: MailTemplate<AccountLockedData> = {
  name: 'account-locked',
  subject: ({ appName }) => `Your ${appName} account is locked`,
  render: (data) => {
    const link = actionLink(data.supportUrl, 'Contact support');

    return layout({
      appName: data.appName,
      text: `Your account has been locked.\n\nReason: ${data.reason}\n\n${link.text}\n\nYour data has not been deleted.`,
      html: `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Your account has been locked after too many failed sign-in attempts.</p>
<p style="margin:0 0 4px;font-size:14px;color:#616e7c;">Reason</p>
<p style="margin:0;font-size:15px;line-height:1.6;">${escapeHtml(data.reason)}</p>
${link.html}
<p style="margin:24px 0 0;font-size:13px;color:#52606d;">Your data has not been deleted.</p>`,
    });
  },
};
