import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

/**
 * Headless test suite. Default environment is 'node'; files that need a DOM declare
 * `// @vitest-environment jsdom` at the top. tests/setup.ts stubs localStorage/window
 * in node so sim modules that touch them can be imported.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    testTimeout: 20000,
    restoreMocks: true,
  },
});
