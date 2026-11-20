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
    // A blocked port must fail fast, not hold the request open for minutes.
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 15_000,
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

/** `Name <a@b.c>` or a bare address, split the way Brevo's API wants it. */
const parseSender = (value: string): { name?: string; email: string } => {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (match) return { name: match[1] || undefined, email: match[2]!.trim() };
  return { email: value.trim() };
};

/** Brevo's transactional API over HTTPS - works where SMTP ports are blocked. */
class BrevoMailProvider implements MailProvider {
  public readonly name = 'brevo';

  // eslint-disable-next-line class-methods-use-this
  async send(message: MailMessage): Promise<void> {
    const sender = parseSender(env.MAIL_FROM || env.SMTP_USER);
    let response: Response;
    try {
      response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': env.BREVO_API_KEY,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          sender,
          to: [{ email: message.to }],
          subject: message.subject,
          textContent: message.text,
          ...(message.html ? { htmlContent: message.html } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      logger.error('Brevo send failed', {
        to: maskEmail(message.to),
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableError('Could not send the email');
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      logger.error('Brevo send rejected', {
        to: maskEmail(message.to),
        status: response.status,
        detail: detail.slice(0, 300),
      });
      throw new ServiceUnavailableError('Could not send the email');
    }
  }
}

const build = (): MailProvider => {
  if (env.MAIL_PROVIDER === 'brevo') {
    if (env.BREVO_API_KEY) return new BrevoMailProvider();
    logger.error('MAIL_PROVIDER=brevo but BREVO_API_KEY is empty - falling back to console');
  }
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
