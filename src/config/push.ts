import jwt from 'jsonwebtoken';
import { env } from './env';
import { logger } from './logger';

export type PushMessage = {
  title: string;
  body: string;
  data?: Record<string, string>;
  /**
   * A job offer must wake the phone and keep ringing until it is answered —
   * that is the promise on the notification-permission screen. Ordinary
   * notifications use the default channel and stay quiet.
   */
  ringing?: boolean;
};

export interface PushProvider {
  readonly name: string;
  send(tokens: string[], message: PushMessage): Promise<void>;
}

class ConsoleProvider implements PushProvider {
  public readonly name = 'console';

  // eslint-disable-next-line class-methods-use-this
  async send(tokens: string[], message: PushMessage): Promise<void> {
    logger.info('Push (console provider)', { devices: tokens.length, ...message });
  }
}

/**
 * Firebase Cloud Messaging over the HTTP v1 API. Access tokens are minted from
 * the service-account key with a signed JWT assertion and cached until shortly
 * before they expire, so a burst of offers costs one token exchange, not one
 * per message.
 */
class FcmProvider implements PushProvider {
  public readonly name = 'fcm';

  private token: { value: string; expiresAt: number } | null = null;

  private async accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.token.expiresAt - 60 > now) return this.token.value;

    const assertion = jwt.sign(
      {
        iss: env.FCM_CLIENT_EMAIL,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3_600,
      },
      // Keys pasted into `.env` carry literal `\n`; restore the real newlines.
      env.FCM_PRIVATE_KEY.replace(/\\n/g, '\n'),
      { algorithm: 'RS256' },
    );

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });

    if (!response.ok) {
      throw new Error(`FCM token exchange failed with ${response.status}`);
    }

    const payload = (await response.json()) as { access_token: string; expires_in: number };
    this.token = { value: payload.access_token, expiresAt: now + payload.expires_in };
    return payload.access_token;
  }

  async send(tokens: string[], message: PushMessage): Promise<void> {
    if (tokens.length === 0) return;

    const accessToken = await this.accessToken();
    const url = `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`;

    // The v1 API takes one device per call; a pro rarely has more than a couple.
    await Promise.all(
      tokens.map(async (token) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token,
              notification: { title: message.title, body: message.body },
              data: message.data ?? {},
              android: {
                priority: 'HIGH',
                notification: {
                  channel_id: message.ringing ? 'ustauz_offers' : 'ustauz_default',
                  sound: message.ringing ? 'offer_ring' : 'default',
                },
              },
              apns: {
                headers: { 'apns-priority': '10' },
                payload: {
                  aps: {
                    sound: message.ringing ? 'offer_ring.caf' : 'default',
                    'interruption-level': message.ringing ? 'time-sensitive' : 'active',
                  },
                },
              },
            },
          }),
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          logger.warn('FCM delivery failed', {
            status: response.status,
            detail: detail.slice(0, 200),
          });
        }
      }),
    );
  }
}

const build = (): PushProvider =>
  env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY
    ? new FcmProvider()
    : new ConsoleProvider();

export const pushProvider: PushProvider = build();
