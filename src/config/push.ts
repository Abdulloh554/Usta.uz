import jwt from 'jsonwebtoken';
import webpush from 'web-push';
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
 * The shape of the message, which differs sharply between a ring and a notice.
 *
 * A ringing offer is sent to Android **data-only**: with a `notification` block
 * the Firebase SDK draws the banner itself and the app is never called, which
 * is precisely the banner the pro was missing. Without one, the app's own
 * messaging service is woken even when the app has been swiped away, and it
 * posts the full-screen, call-style notification instead (see
 * `mobile/plugins/offer-ring/OfferRingService.kt`). The title and body
 * therefore travel in `data`, because that is where the app will look for them.
 *
 * iOS has no equivalent, so it keeps a real alert payload — `apns` carries it
 * on its own, and the category is what puts the two buttons on it.
 */
const buildFcmMessage = (message: PushMessage): Record<string, unknown> => {
  const apns = {
    headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
    payload: {
      aps: {
        alert: { title: message.title, body: message.body },
        sound: message.ringing ? 'offer_ring.wav' : 'default',
        ...(message.ringing ? { category: 'ustauz_offer' } : {}),
        'interruption-level': message.ringing ? 'time-sensitive' : 'active',
      },
    },
  };

  if (!message.ringing) {
    return {
      notification: { title: message.title, body: message.body },
      data: message.data ?? {},
      android: {
        priority: 'HIGH',
        notification: { channel_id: 'ustauz_default', sound: 'default' },
      },
      apns,
    };
  }

  const data = { ...(message.data ?? {}), title: message.title, body: message.body };

  return {
    data,
    android: {
      priority: 'HIGH',
      // An offer that arrives after its window has closed is worse than no
      // offer: it rings for a job that is already someone else's.
      ttl: '60s',
      data,
    },
    apns,
  };
};

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
    const body = buildFcmMessage(message);

    // The v1 API takes one device per call; a pro rarely has more than a couple.
    await Promise.all(
      tokens.map(async (token) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ message: { token, ...body } }),
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

/* ── Web Push, for the web app ──────────────────────────────────────────── */

/**
 * A browser's push subscription travels as an ordinary device token, so it can
 * share `User.pushTokens`, the notification queue and broadcasts with phone
 * tokens unchanged. The prefix tells the two apart; the rest is the
 * subscription JSON, base64url-encoded so it stays one opaque string.
 */
export const WEB_PUSH_PREFIX = 'webpush:';

export const isWebPushToken = (token: string): boolean => token.startsWith(WEB_PUSH_PREFIX);

/**
 * The browsers' push services. The endpoint comes from the client and this
 * server POSTs to it, so anything else is refused — otherwise a crafted
 * "subscription" could aim the API at an internal address.
 */
const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com', // Chrome, Edge on Android, Opera, Samsung Internet
  'updates.push.services.mozilla.com', // Firefox
  'notify.windows.com', // Edge on Windows (`*.notify.windows.com`)
  'push.apple.com', // Safari (`web.push.apple.com`)
];

export const isPushServiceEndpoint = (endpoint: string): boolean => {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.port !== '') return false;
    return PUSH_SERVICE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
};

export const decodeWebPushToken = (token: string): webpush.PushSubscription | null => {
  try {
    const json = Buffer.from(token.slice(WEB_PUSH_PREFIX.length), 'base64url').toString('utf8');
    const subscription = JSON.parse(json) as webpush.PushSubscription;
    if (typeof subscription.endpoint !== 'string' || !subscription.keys?.p256dh || !subscription.keys?.auth) {
      return null;
    }
    return isPushServiceEndpoint(subscription.endpoint) ? subscription : null;
  } catch {
    return null;
  }
};

/**
 * Called with tokens a push service has declared dead (the browser
 * unsubscribed, or the site's permission was revoked), so they can be dropped.
 * Registered by the notification module, which owns the user documents.
 */
let onStaleTokens: ((tokens: string[]) => Promise<void>) | null = null;

export const setStaleTokenHandler = (handler: (tokens: string[]) => Promise<void>): void => {
  onStaleTokens = handler;
};

export const webPushEnabled = (): boolean => Boolean(env.WEB_PUSH_PUBLIC_KEY && env.WEB_PUSH_PRIVATE_KEY);

export class WebPushProvider implements PushProvider {
  public readonly name = 'webpush';

  constructor() {
    webpush.setVapidDetails(env.WEB_PUSH_SUBJECT, env.WEB_PUSH_PUBLIC_KEY, env.WEB_PUSH_PRIVATE_KEY);
  }

  // eslint-disable-next-line class-methods-use-this
  async send(tokens: string[], message: PushMessage): Promise<void> {
    const payload = JSON.stringify({
      title: message.title,
      body: message.body,
      data: message.data ?? {},
      ringing: Boolean(message.ringing),
    });
    const stale: string[] = [];

    await Promise.all(
      tokens.map(async (token) => {
        const subscription = decodeWebPushToken(token);
        if (!subscription) {
          stale.push(token);
          return;
        }
        try {
          await webpush.sendNotification(subscription, payload, {
            // An offer delivered after its window has closed rings for a job
            // that is already someone else's — the same rule as on Android.
            TTL: message.ringing ? 60 : 24 * 60 * 60,
            urgency: message.ringing ? 'high' : 'normal',
            topic: message.ringing ? 'offer' : undefined,
          });
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            stale.push(token);
            return;
          }
          logger.warn('Web push delivery failed', {
            status,
            message: error instanceof Error ? error.message.slice(0, 200) : String(error),
          });
        }
      }),
    );

    if (stale.length > 0 && onStaleTokens) await onStaleTokens(stale).catch(() => undefined);
  }
}

/**
 * Sends each token through the service it belongs to: browser subscriptions
 * through Web Push, everything else through FCM (or the console in
 * development). One failing half never stops the other.
 */
export class RoutingProvider implements PushProvider {
  public readonly name: string;

  constructor(
    private readonly devices: PushProvider,
    private readonly browsers: PushProvider | null,
  ) {
    this.name = browsers ? `${devices.name}+${browsers.name}` : devices.name;
  }

  async send(tokens: string[], message: PushMessage): Promise<void> {
    const web = tokens.filter(isWebPushToken);
    const native = tokens.filter((token) => !isWebPushToken(token));

    await Promise.all([
      native.length > 0 ? this.devices.send(native, message) : Promise.resolve(),
      web.length > 0 && this.browsers ? this.browsers.send(web, message) : Promise.resolve(),
    ]);
  }
}

const build = (): PushProvider =>
  new RoutingProvider(
    env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY ? new FcmProvider() : new ConsoleProvider(),
    webPushEnabled() ? new WebPushProvider() : null,
  );

export const pushProvider: PushProvider = build();
