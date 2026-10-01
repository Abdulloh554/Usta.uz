import type { Request } from 'express';
import { clientIp, keyFor } from '../../src/common/middlewares/rateLimit.middleware';
import { env } from '../../src/config/env';

const SECRET = 'bff-secret-that-is-long-enough-for-the-schema-32';

const request = (headers: Record<string, string>, ip = '10.0.0.1'): Request =>
  ({ headers, ip }) as unknown as Request;

describe('rate-limit client address', () => {
  const original = env.BFF_SHARED_SECRET;

  afterEach(() => {
    (env as { BFF_SHARED_SECRET?: string }).BFF_SHARED_SECRET = original;
  });

  it('uses the socket address when no secret is configured', () => {
    (env as { BFF_SHARED_SECRET?: string }).BFF_SHARED_SECRET = undefined;
    expect(clientIp(request({ 'x-bff-secret': SECRET, 'x-client-ip': '203.0.113.9' }))).toBe(
      '10.0.0.1',
    );
  });

  describe('with the web server secret configured', () => {
    beforeEach(() => {
      (env as { BFF_SHARED_SECRET?: string }).BFF_SHARED_SECRET = SECRET;
    });

    it('trusts the forwarded address when the secret matches', () => {
      expect(clientIp(request({ 'x-bff-secret': SECRET, 'x-client-ip': '203.0.113.9' }))).toBe(
        '203.0.113.9',
      );
    });

    it('ignores the forwarded address without the secret', () => {
      expect(clientIp(request({ 'x-client-ip': '203.0.113.9' }))).toBe('10.0.0.1');
    });

    it('ignores the forwarded address with a wrong secret', () => {
      expect(
        clientIp(request({ 'x-bff-secret': `${SECRET}x`, 'x-client-ip': '203.0.113.9' })),
      ).toBe('10.0.0.1');
    });

    it('ignores a forwarded value that is not an address', () => {
      expect(clientIp(request({ 'x-bff-secret': SECRET, 'x-client-ip': 'u:someone' }))).toBe(
        '10.0.0.1',
      );
    });

    it('keys an anonymous relayed request by the visitor, as the /64 for IPv6', () => {
      expect(
        keyFor(request({ 'x-bff-secret': SECRET, 'x-client-ip': '2001:db8:1:2:3:4:5:6' })),
      ).toBe('ip:2001:db8:1:2');
    });
  });
});
