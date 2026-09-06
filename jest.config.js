/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  // `env.ts` runs before the module registry is built, so `src/config/env`
  // parses test values rather than whatever is in the developer's `.env`.
  setupFiles: ['<rootDir>/tests/helpers/env.ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testMatch: ['**/*.test.ts', '**/*.spec.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/server.ts',
    '!src/**/*.types.ts',
    '!src/**/*.routes.ts',
    '!src/config/**',
    // Infrastructure wiring, not application logic: the queue and socket
    // bootstraps are stubbed for the suite, so measuring them would report
    // coverage of the stubs rather than of anything the tests exercise.
    '!src/jobs/**',
    '!src/sockets/index.ts',
  ],
  coverageThreshold: {
    global: { branches: 60, functions: 70, lines: 70, statements: 70 },
  },
  testTimeout: 30000,
  clearMocks: true,
};
