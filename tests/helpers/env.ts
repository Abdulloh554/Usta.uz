/**
 * Test environment. Loaded before `src/config/env` is imported anywhere, so the
 * schema sees complete, valid values rather than a developer's local `.env`.
 */
process.env.NODE_ENV = 'test';
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/ustauz-test';
process.env.REDIS_URL = 'redis://127.0.0.1:6379';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-long-enough-32';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-that-is-long-enough-32';
process.env.BCRYPT_ROUNDS = '4';
process.env.SMS_PROVIDER = 'console';
process.env.ORDER_ACCEPT_FEE = '4999';
process.env.MATCH_OFFER_TIMEOUT_SECONDS = '45';

export {};
