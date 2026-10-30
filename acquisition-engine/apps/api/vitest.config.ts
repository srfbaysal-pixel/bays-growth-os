import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    setupFiles: ['tests/setup.ts'],
    reporters: process.env.CI ? ['default', 'json'] : ['default'],
    outputFile: { json: '../../reports/vitest-api.json' }
  }
});
