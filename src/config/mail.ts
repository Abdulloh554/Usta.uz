import nodemailer from 'nodemailer';
import { env, isProduction } from './env';
import { logger } from './logger';
import { ServiceUnavailableError } from '../common/errors/ApiError';
import { maskEmail } from '../common/utils/email';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailProvider {
  readonly name: string;
  send(message: MailMessage): Promise<void>;
}

/** Development and test default: the message goes to the log, nothing is sent. */
class ConsoleMailProvider implements MailProvider {
  public readonly name = 'console';

  // eslint-disable-next-line class-methods-use-this
  async send(message: MailMessage): Promise<void> {
    logger.info('Email (console provider)', {
      to: maskEmail(message.to),
      subject: message.subject,
      text: message.text,
    });
  }
}

/** Any SMTP server — Gmail with an app password is the zero-cost default. */
class SmtpMailProvider implements MailProvider {
  public readonly name = 'smtp';

  private readonly transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // 465 is implicit TLS; 587 upgrades with STARTTLS.
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
  });

  // eslint-disable-next-line class-methods-use-this
  private get from(): string {
    return env.MAIL_FROM || env.SMTP_USER;
  }

  async send(message: MailMessage): Promise<void> {
    try {
      await this.transport.sendMail({ from: this.from, ...message });
    } catch (error) {
      logger.error('SMTP send failed', {
        to: maskEmail(message.to),
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableError('Could not send the email');
    }
  }
}

const build = (): MailProvider => {
  if (env.MAIL_PROVIDER === 'smtp') {
    if (env.SMTP_USER && env.SMTP_PASSWORD) return new SmtpMailProvider();
    // Boot anyway (as with the SMS providers) so a half-configured deploy still
    // serves sign-in; only the reset code is lost, and the log says why.
    logger.error('MAIL_PROVIDER=smtp but SMTP_USER / SMTP_PASSWORD are empty - falling back to console');
  }
  if (isProduction) {
    logger.warn('MAIL_PROVIDER is "console" in production — no real emails will be sent');
  }
  return new ConsoleMailProvider();
};

export const mailProvider: MailProvider = build();
