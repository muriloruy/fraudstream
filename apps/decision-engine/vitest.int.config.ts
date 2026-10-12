import { defineProject, mergeConfig } from 'vitest/config';
import { sharedIntegrationConfig } from '../../vitest.shared.js';

export default mergeConfig(
  sharedIntegrationConfig,
  defineProject({
    test: { name: 'decision-engine:int' },
  }),
);
