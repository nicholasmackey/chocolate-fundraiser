import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Each D1-backed file starts its own in-memory workerd instance.
    fileParallelism: false,
  },
});
