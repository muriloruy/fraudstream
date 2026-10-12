import { defineProject, mergeConfig } from 'vitest/config';
import { sharedE2eConfig } from '../../vitest.shared.js';

export default mergeConfig(
  sharedE2eConfig,
  defineProject({
    test: { name: 'e2e' },
  }),
);
