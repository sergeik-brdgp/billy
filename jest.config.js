/** @type {import('jest').Config} */
module.exports = {
  // iOS/default jest-expo preset (not the universal multi-platform one).
  preset: 'jest-expo',
  testMatch: [
    '<rootDir>/src/ui/**/*.test.{ts,tsx}',
    '<rootDir>/src/adapters/**/*.test.ts',
    '<rootDir>/src/main/**/*.test.{ts,tsx}',
  ],
  setupFiles: ['<rootDir>/jest.setup.js'],
  // Generous per-test timeout: under heavy machine load the async UI tests took > 5 s (default).
  testTimeout: 20000,
  modulePathIgnorePatterns: ['<rootDir>/mock-kit/', '<rootDir>/ios/', '<rootDir>/android/'],
};
