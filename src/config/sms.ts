import { env, isProduction } from './env';
import { logger } from './logger';
import { ServiceUnavailableError } from '../common/errors/ApiError';
import { maskPhone } from '../common/utils/phone';

export interface SmsProvider {
  readonly name: string;
  send(phone: string, message: string): Promise<void>;
}

/** Development and test default: the code goes to the log, no money is spent. */
class ConsoleProvider implements SmsProvider {
  public readonly name = 'console';

  // eslint-disable-next-line class-methods-use-this
  async send(phone: string, message: string): Promise<void> {
    logger.info('SMS (console provider)', { to: maskPhone(phone), message });
  }
}

/** Eskiz.uz — token-based, and the token expires, so it is refreshed on 401. */
class EskizProvider implements SmsProvider {
  public readonly name = 'eskiz';

  private token: string | null = null;

  private async login(): Promise<string> {
    const response = await fetch(`${env.ESKIZ_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: env.ESKIZ_EMAIL, password: env.ESKIZ_PASSWORD }),
    });
    if (!response.ok) {
      throw new ServiceUnavailableError('Could not authenticate with the SMS provider');
    }
    const payload = (await response.json()) as { data?: { token?: string } };
    const token = payload.data?.token;
    if (!token) throw new ServiceUnavailableError('SMS provider returned no token');
    this.token = token;
    return token;
  }

  private async post(token: string, phone: string, message: string): Promise<Response> {
    const body = new FormData();
    // Eskiz wants the number without a `+`.
    body.append('mobile_phone', phone.replace(/\D/g, ''));
    body.append('message', message);
    body.append('from', env.ESKIZ_FROM);

    return fetch(`${env.ESKIZ_BASE_URL}/message/sms/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body,
    });
  }

  async send(phone: string, message: string): Promise<void> {
    let token = this.token ?? (await this.login());
    let response = await this.post(token, phone, message);

    if (response.status === 401) {
      token = await this.login();
      response = await this.post(token, phone, message);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      logger.error('Eskiz SMS send failed', { status: response.status, detail: detail.slice(0, 300) });
      throw new ServiceUnavailableError('Could not send the SMS');
    }
  }
}

/** Play Mobile — HTTP basic auth, JSON envelope. */
class PlayMobileProvider implements SmsProvider {
  public readonly name = 'playmobile';

  async send(phone: string, message: string): Promise<void> {
    const auth = Buffer.from(`${env.PLAYMOBILE_LOGIN}:${env.PLAYMOBILE_PASSWORD}`).toString('base64');
    const response = await fetch(`${env.PLAYMOBILE_BASE_URL}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        messages: [
          {
            recipient: phone.replace(/\D/g, ''),
            'message-id': `ustauz-${Date.now()}`,
            sms: { originator: '3700', content: { text: message } },
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      logger.error('Play Mobile SMS send failed', {
        status: response.status,
        detail: detail.slice(0, 300),
      });
      throw new ServiceUnavailableError('Could not send the SMS');
    }
  }
}

const build = (): SmsProvider => {
  switch (env.SMS_PROVIDER) {
    case 'eskiz':
      return new EskizProvider();
    case 'playmobile':
      return new PlayMobileProvider();
    default:
      if (isProduction) {
        logger.warn('SMS_PROVIDER is "console" in production — no real messages will be sent');
      }
      return new ConsoleProvider();
  }
};

export const smsProvider: SmsProvider = build();
