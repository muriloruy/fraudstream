import { defineConfig } from 'vitest/config';

// Lets `pnpm exec vitest` run every project at once; CI uses `nx run-many -t test`.
export default defineConfig({
  test: {
    projects: ['libs/*', 'apps/*'],
  },
});
