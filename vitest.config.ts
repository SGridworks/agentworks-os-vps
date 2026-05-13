import { defineConfig } from 'vitest/config';
import { sharedTestConfig } from './vitest.shared';

export default defineConfig({
  test: {
    ...sharedTestConfig,
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.d.ts',
        '**/*.test.ts',
        '**/tests/**',
      ],
    },
  },
});
