import type { Request } from 'express';
import { keyFor, phoneKeyFor } from '../../src/common/middlewares/rateLimit.middleware';

const request = (body: unknown, ip = '10.0.0.1'): Request =>
  ({ body, headers: {}, ip }) as unknown as Request;

describe('phone-keyed rate limits (login, forgot-password)', () => {
  it('keys by the normalised phone, so every spelling of a number shares one bucket', () => {
    const expected = 'phone:+998901234567';
    expect(phoneKeyFor(request({ phone: '+998901234567' }))).toBe(expected);
    expect(phoneKeyFor(request({ phone: '998 90 123 45 67' }))).toBe(expected);
    expect(phoneKeyFor(request({ phone: '90-123-45-67' }))).toBe(expected);
    expect(phoneKeyFor(request({ phone: ' (90) 1234567 ' }))).toBe(expected);
  });

  it('is independent of the caller address', () => {
    expect(phoneKeyFor(request({ phone: '901234567' }, '10.0.0.1'))).toBe(
      phoneKeyFor(request({ phone: '901234567' }, '203.0.113.7')),
    );
  });

  it('gives different numbers different buckets', () => {
    expect(phoneKeyFor(request({ phone: '901234567' }))).not.toBe(
      phoneKeyFor(request({ phone: '901234568' })),
    );
  });

  it.each([
    ['no body', undefined],
    ['no phone', {}],
    ['a non-string phone', { phone: { $gt: '' } }],
    ['an invalid number', { phone: '12345' }],
    ['an unknown operator', { phone: '+998111234567' }],
  ])('falls back to the caller key for %s', (_label, body) => {
    const req = request(body, '203.0.113.7');
    expect(phoneKeyFor(req)).toBe(keyFor(req));
    expect(phoneKeyFor(req)).toBe('ip:203.0.113.7');
  });
});
