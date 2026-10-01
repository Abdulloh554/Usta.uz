import webpush from 'web-push';
import {
  RoutingProvider,
  WEB_PUSH_PREFIX,
  WebPushProvider,
  decodeWebPushToken,
  isPushServiceEndpoint,
  setStaleTokenHandler,
  type PushProvider,
} from '../../src/config/push';

jest.mock('web-push', () => ({
  __esModule: true,
  default: { setVapidDetails: jest.fn(), sendNotification: jest.fn() },
}));

const send = webpush.sendNotification as jest.MockedFunction<typeof webpush.sendNotification>;

const subscription = (endpoint: string) => ({
  endpoint,
  keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' },
});

const tokenFor = (endpoint: string): string =>
  `${WEB_PUSH_PREFIX}${Buffer.from(JSON.stringify(subscription(endpoint))).toString('base64url')}`;

const CHROME = 'https://fcm.googleapis.com/fcm/send/abc:def';
const MESSAGE = { title: 'Yangi elon', body: 'Rozetka', data: { type: 'order_offer' }, ringing: true };

describe('web push tokens', () => {
  it('accepts the browsers’ push services only', () => {
    expect(isPushServiceEndpoint(CHROME)).toBe(true);
    expect(isPushServiceEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isPushServiceEndpoint('https://wns2-db5p.notify.windows.com/w/?token=x')).toBe(true);
    expect(isPushServiceEndpoint('https://web.push.apple.com/QGuQ')).toBe(true);
  });

  it('refuses anything that could aim the server elsewhere', () => {
    expect(isPushServiceEndpoint('http://fcm.googleapis.com/fcm/send/x')).toBe(false);
    expect(isPushServiceEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false);
    expect(isPushServiceEndpoint('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isPushServiceEndpoint('https://fcm.googleapis.com.evil.example/x')).toBe(false);
    expect(isPushServiceEndpoint('https://evilfcm.googleapis.com.example/x')).toBe(false);
    expect(isPushServiceEndpoint('not a url')).toBe(false);
  });

  it('round-trips a subscription and rejects broken ones', () => {
    expect(decodeWebPushToken(tokenFor(CHROME))?.endpoint).toBe(CHROME);
    expect(decodeWebPushToken(`${WEB_PUSH_PREFIX}not-base64-json`)).toBeNull();
    expect(decodeWebPushToken(tokenFor('https://internal.example/hook'))).toBeNull();
  });
});

describe('push routing', () => {
  beforeEach(() => send.mockReset());

  it('sends phone tokens to the device provider and browser tokens through web push', async () => {
    const deviceSend = jest.fn().mockResolvedValue(undefined);
    const devices: PushProvider = { name: 'fake', send: deviceSend };
    const provider = new RoutingProvider(devices, new WebPushProvider());
    send.mockResolvedValue({ statusCode: 201, body: '', headers: {} });

    await provider.send(['fcm-token-1234567890', tokenFor(CHROME)], MESSAGE);

    expect(deviceSend).toHaveBeenCalledWith(['fcm-token-1234567890'], MESSAGE);
    expect(send).toHaveBeenCalledTimes(1);
    const [target, payload, options] = send.mock.calls[0]!;
    expect(target.endpoint).toBe(CHROME);
    expect(JSON.parse(payload as string)).toMatchObject({ title: 'Yangi elon', ringing: true });
    // A ring that arrives after its window has closed is worse than none.
    expect(options).toMatchObject({ TTL: 60, urgency: 'high' });
  });

  it('skips browser tokens when web push is not configured', async () => {
    const deviceSend = jest.fn().mockResolvedValue(undefined);
    await new RoutingProvider({ name: 'fake', send: deviceSend }, null).send([tokenFor(CHROME)], MESSAGE);
    expect(deviceSend).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('reports subscriptions the push service says are gone', async () => {
    const stale = jest.fn().mockResolvedValue(undefined);
    setStaleTokenHandler(stale);
    const gone = tokenFor('https://fcm.googleapis.com/fcm/send/gone');
    send.mockImplementation(async (sub) => {
      if (sub.endpoint.endsWith('/gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
      return { statusCode: 201, body: '', headers: {} };
    });

    await new WebPushProvider().send([gone, tokenFor(CHROME)], MESSAGE);

    expect(stale).toHaveBeenCalledWith([gone]);
  });
});
