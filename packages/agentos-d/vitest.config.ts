import { defineConfig } from 'vitest/config';
import { sharedTestConfig } from '../../vitest.shared';

export default defineConfig({
  test: {
    ...sharedTestConfig,
    include: ['src/**/*.test.ts', 'tests/integration/process-watcher.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
