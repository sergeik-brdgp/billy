import { defineConfig } from 'vitest/config';

// Core + integration tests run in plain Node against the real mock.
// UI tests are jest-expo only (jest.config.js); keep the two runners' file sets disjoint.
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/core/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'mock-kit/**', 'ios/**', 'android/**'],
  },
});
