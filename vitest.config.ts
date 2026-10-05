import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: [
            'packages/*/test/**/*.test.ts',
            'scenarios/*/test/**/*.test.ts',
            'scripts/lab/test/**/*.test.ts',
          ],
          exclude: ['**/*.int.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['packages/*/test/**/*.int.test.ts', 'scenarios/*/test/**/*.int.test.ts'],
          testTimeout: 30_000,
          // Starting Anvil in beforeAll can take longer than the default 10 s while the suite runs in parallel.
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
