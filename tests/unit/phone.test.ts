import {
  formatPhone,
  isValidUzPhone,
  maskPhone,
  normalizePhone,
  operatorOf,
  toNationalDigits,
} from '../../src/common/utils/phone';
import { BadRequestError } from '../../src/common/errors/ApiError';

describe('phone utilities', () => {
  describe('toNationalDigits', () => {
    it('strips formatting and the country code', () => {
      expect(toNationalDigits('+998 90 123 45 67')).toBe('901234567');
      expect(toNationalDigits('998901234567')).toBe('901234567');
      expect(toNationalDigits('901234567')).toBe('901234567');
    });

    it('survives empty and junk input', () => {
      expect(toNationalDigits('')).toBe('');
      expect(toNationalDigits('abc')).toBe('');
    });

    /**
     * 99 830 38 23 is a real Uzmobile number whose national form starts with the
     * country code. Stripping unconditionally cut it to `303823` and sign-up
     * rejected it.
     */
    it('keeps a national number that itself begins with 998', () => {
      expect(toNationalDigits('998303823')).toBe('998303823');
      expect(toNationalDigits('+998998303823')).toBe('998303823');
      expect(toNationalDigits('+998 99 830 38 23')).toBe('998303823');
    });
  });

  describe('operatorOf', () => {
    it.each([
      ['901234567', 'Beeline'],
      ['931234567', 'Ucell'],
      ['971234567', 'Mobiuz'],
      ['881234567', 'Humans'],
      ['201234567', 'Uztelecom'],
    ])('resolves %s to %s', (phone, operator) => {
      expect(operatorOf(phone)).toBe(operator);
    });

    it('returns null for a code no Uzbek network uses', () => {
      expect(operatorOf('121234567')).toBeNull();
    });
  });

  describe('isValidUzPhone', () => {
    it('accepts a well-formed number in any input shape', () => {
      expect(isValidUzPhone('+998 90 123 45 67')).toBe(true);
      expect(isValidUzPhone('998901234567')).toBe(true);
    });

    it('rejects a wrong length', () => {
      expect(isValidUzPhone('+99890123456')).toBe(false);
      expect(isValidUzPhone('+9989012345678')).toBe(false);
    });

    it('rejects an unknown operator code', () => {
      expect(isValidUzPhone('+998121234567')).toBe(false);
    });

    it('accepts a number whose national part starts with 998', () => {
      expect(operatorOf('+998998303823')).toBe('Uzmobile');
      expect(isValidUzPhone('+998998303823')).toBe(true);
      expect(isValidUzPhone('998303823')).toBe(true);
      expect(normalizePhone('+998 99 830 38 23')).toBe('+998998303823');
    });
  });

  describe('normalizePhone', () => {
    it('produces one canonical stored form', () => {
      expect(normalizePhone('+998 90 123 45 67')).toBe('+998901234567');
      expect(normalizePhone('90-123-45-67')).toBe('+998901234567');
    });

    it('throws with a field-level detail on a bad length', () => {
      expect(() => normalizePhone('9012345')).toThrow(BadRequestError);
      try {
        normalizePhone('9012345');
      } catch (error) {
        expect((error as BadRequestError).details).toEqual([
          { field: 'phone', message: 'invalid_length' },
        ]);
      }
    });

    it('throws on an unknown operator', () => {
      try {
        normalizePhone('121234567');
      } catch (error) {
        expect((error as BadRequestError).details).toEqual([
          { field: 'phone', message: 'unknown_operator' },
        ]);
      }
    });
  });

  it('formats for display exactly as the design placeholder does', () => {
    expect(formatPhone('998901234567')).toBe('+998 90 123 45 67');
  });

  it('masks the middle for logs', () => {
    expect(maskPhone('+998901234567')).toBe('+998 90 *** ** 67');
    expect(maskPhone('nonsense')).toBe('***');
  });
});
