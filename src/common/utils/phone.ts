import { BadRequestError } from '../errors/ApiError';

/**
 * Uzbek mobile operator codes. The design validates a signup number by its
 * operator prefix and shows the operator's name back to the user — no SMS is
 * sent at that point — so the same table drives both the API and the UI copy.
 */
export const OPERATOR_CODES: Readonly<Record<string, string>> = Object.freeze({
  '90': 'Beeline',
  '91': 'Beeline',
  '93': 'Ucell',
  '94': 'Ucell',
  '95': 'Uzmobile',
  '97': 'Mobiuz',
  '98': 'Perfectum',
  '99': 'Uzmobile',
  '88': 'Humans',
  '33': 'Humans',
  '77': 'Mobiuz',
  '20': 'Uztelecom',
});

const COUNTRY_CODE = '998';
const NATIONAL_LENGTH = 9;

/**
 * Strip everything that is not a digit and drop a leading country code — but
 * only when the country code is genuinely there.
 *
 * A national number may itself begin with 998: 99 830 38 23 is `998303823`.
 * Stripping unconditionally cut that to the six digits `303823`, and because
 * `operatorOf` and `normalizePhone` strip again on an already-national number,
 * a real Uzmobile number was rejected as invalid at sign-up.
 */
export const toNationalDigits = (input: string): string => {
  const digits = String(input ?? '').replace(/\D/g, '');
  return digits.length > NATIONAL_LENGTH && digits.startsWith(COUNTRY_CODE)
    ? digits.slice(COUNTRY_CODE.length)
    : digits;
};

export const operatorOf = (input: string): string | null => {
  const national = toNationalDigits(input);
  const code = national.slice(0, 2);
  return OPERATOR_CODES[code] ?? null;
};

export const isValidUzPhone = (input: string): boolean => {
  const national = toNationalDigits(input);
  return national.length === NATIONAL_LENGTH && operatorOf(national) !== null;
};

/** Canonical stored form: `+998901234567`. One shape in the database, always. */
export const normalizePhone = (input: string): string => {
  const national = toNationalDigits(input);

  if (national.length !== NATIONAL_LENGTH) {
    throw new BadRequestError('Phone number must have 9 digits after the country code', [
      { field: 'phone', message: 'invalid_length' },
    ]);
  }
  if (operatorOf(national) === null) {
    throw new BadRequestError('Unknown Uzbek mobile operator code', [
      { field: 'phone', message: 'unknown_operator' },
    ]);
  }

  return `+${COUNTRY_CODE}${national}`;
};

/** Display form: `+998 90 123 45 67`, matching the design's placeholder. */
export const formatPhone = (input: string): string => {
  const national = toNationalDigits(input);
  if (national.length !== NATIONAL_LENGTH) return input;
  const [, code, a, b, c] = /^(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(national) ?? [];
  return `+${COUNTRY_CODE} ${code} ${a} ${b} ${c}`;
};

/** Partly masked, for logs and for showing "we texted ***67". */
export const maskPhone = (input: string): string => {
  const national = toNationalDigits(input);
  if (national.length !== NATIONAL_LENGTH) return '***';
  return `+${COUNTRY_CODE} ${national.slice(0, 2)} *** ** ${national.slice(-2)}`;
};
