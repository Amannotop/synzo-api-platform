import type { AppConfig } from '@synzo/config';
import type { AccountTokenPurpose } from '../services/account-token.types.js';

export interface OutboundMail {
  to: string;
  from: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: OutboundMail): Promise<void>;
}

/**
 * Sends account-recovery and verification email.
 *
 * Production submits over SMTP via SMTP_URL. Development and test print the
 * message to stdout so the flow can be completed locally without a mail
 * server. buildConfig() refuses to let the `log` transport run when
 * NODE_ENV=production, because a reset link in the log stream is a working
 * credential in the hands of anyone with log access.
 *
 * Messages are never passed through the structured logger for the same
 * reason: those logs are shipped off-box.
 */
export function createMailer(config: AppConfig): Mailer {
  if (config.mail.transport === 'log') {
    return {
      async send(mail) {
        process.stdout.write(
          [
            '',
            '--- synzo: outbound mail (development only) -----------------',
            `To:      ${mail.to}`,
            `From:    ${mail.from}`,
            `Subject: ${mail.subject}`,
            '',
            ...mail.text.split('\n'),
            '-----------------------------------------------------------',
            '',
          ].join('\n'),
        );
      },
    };
  }

  const url = config.mail.smtpUrl!;
  // The transport is created once and reused. nodemailer pools connections
  // internally, so a new client per email would mean a new TCP+TLS handshake
  // per reset request.
  const transportPromise = import('nodemailer').then(({ createTransport }) => createTransport(url));
  return {
    async send(mail) {
      const transport = await transportPromise;
      await transport.sendMail({
        from: mail.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
      });
    },
  };
}

/**
 * Builds the customer-facing link that embeds a one-time token.
 *
 * `publicOrigin` is the origin the customer actually reached us on, resolved
 * from the request. It is a required argument rather than read from config so
 * this function cannot silently fall back to a development default and mint a
 * link that is dead for the recipient.
 */
export function accountTokenLink(
  publicOrigin: string,
  purpose: AccountTokenPurpose,
  raw: string,
): string {
  const path = purpose === 'password_reset' ? 'reset-password' : 'verify-email';
  return `${publicOrigin.replace(/\/+$/, '')}/${path}?token=${encodeURIComponent(raw)}`;
}

const SUBJECTS: Record<AccountTokenPurpose, string> = {
  password_reset: 'Reset your Synzo password',
  email_verification: 'Confirm your Synzo email address',
};

function bodyFor(purpose: AccountTokenPurpose, link: string, minutesLeft: number): string {
  if (purpose === 'password_reset') {
    return [
      'We received a request to reset the password for your Synzo account.',
      '',
      'Open this link to choose a new password:',
      link,
      '',
      `The link expires in ${minutesLeft} minutes and can be used once.`,
      '',
      'If you did not request this, you can ignore this email. Nothing has changed,',
      'and your current password still works.',
    ].join('\n');
  }
  return [
    'Please confirm your email address to finish setting up your Synzo account.',
    '',
    'Open this link to verify your address:',
    link,
    '',
    `The link expires in ${Math.round(minutesLeft / 60)} hours and can be used once.`,
    '',
    'If you did not create this account, you can ignore this email.',
  ].join('\n');
}

export function accountTokenMail(
  config: AppConfig,
  args: {
    to: string;
    purpose: AccountTokenPurpose;
    raw: string;
    expiresAt: Date;
    publicOrigin: string;
  },
): OutboundMail {
  const link = accountTokenLink(args.publicOrigin, args.purpose, args.raw);
  const minutesLeft = Math.max(1, Math.round((args.expiresAt.getTime() - Date.now()) / 60_000));
  return {
    to: args.to,
    from: config.mail.from,
    subject: SUBJECTS[args.purpose],
    text: bodyFor(args.purpose, link, minutesLeft),
  };
}
