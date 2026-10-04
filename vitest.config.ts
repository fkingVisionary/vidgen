import { defineConfig } from 'vitest/config';

/**
 * Two test projects:
 *  - unit:        pure logic + mock providers. No database, no network. `pnpm test`
 *  - integration: real PostgreSQL (TEST_DATABASE_URL). `pnpm test:int`
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'modules/*/src/**/*.test.ts', 'apps/api/src/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/*/src/**/*.int.test.ts', 'modules/*/src/**/*.int.test.ts', 'apps/api/src/**/*.int.test.ts'],
          exclude: ['**/node_modules/**'],
          environment: 'node',
          globalSetup: ['./test/integration-setup.ts'],
          // Integration tests share one database; run files one at a time.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
