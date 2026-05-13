import type { InlineConfig } from 'vitest';

// Shared vitest test config for every package in this workspace.
// Reason: 9 package-level configs × default thread pool (10 workers) × N concurrent
// agents triggered by wake-on-assign was a fork bomb that hung the host
// (16GB RAM) on 2026-04-28. singleFork forces one process per package run; the
// root package.json caps workspace concurrency at 1 so packages run sequentially.
export const sharedTestConfig = {
  globals: true,
  environment: 'node',
  pool: 'forks',
  poolOptions: {
    forks: {
      singleFork: true,
      maxForks: 1,
    },
  },
} satisfies InlineConfig;
