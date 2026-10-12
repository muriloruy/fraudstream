import { defineConfig } from 'vitest/config';

/** Defaults shared by every project's vitest.config.ts. */
// Resolve workspace libs to their TypeScript sources (see the libs' package.json "exports").
const SOURCE_CONDITIONS = ['@fraudstream/source'];

export const sharedTestConfig = defineConfig({
  resolve: { conditions: SOURCE_CONDITIONS },
  ssr: { resolve: { conditions: SOURCE_CONDITIONS } },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts', 'src/main.ts'],
    },
  },
});

/**
 * Integration tests (`*.int.test.ts`) start real PostgreSQL / Kafka containers with
 * Testcontainers, so they get long timeouts and run one file at a time.
 */
export const sharedIntegrationConfig = defineConfig({
  resolve: { conditions: SOURCE_CONDITIONS },
  ssr: { resolve: { conditions: SOURCE_CONDITIONS } },
  test: {
    include: ['src/**/*.int.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
});

/** End-to-end tests (`*.e2e.test.ts`) run against the compose stack started beforehand. */
export const sharedE2eConfig = defineConfig({
  test: {
    include: ['src/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
