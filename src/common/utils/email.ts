/** Canonical stored form: trimmed and lower-cased, so one address is one account. */
export const normalizeEmail = (input: string): string => String(input ?? '').trim().toLowerCase();

/** `dilnoza@gmail.com` → `di***@gmail.com`, for logs that must not hold full addresses. */
export const maskEmail = (email: string): string => {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
};
