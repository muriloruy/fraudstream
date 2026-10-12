import { ConsumerGroups, Topics } from '@fraudstream/contracts';
import type { DestinationStream } from '@fraudstream/observability';
import { createConsumerService, type ConsumerServiceOptions } from '@fraudstream/service-kit';
import { ruleHandlers } from './application/evaluate-transaction.js';
import type { FraudRulesConfig } from './config/config.js';
import { loadRuleset } from './config/ruleset-loader.js';
import { RulesRepository } from './infrastructure/db/rules.repository.js';

export const SERVICE_NAME = 'fraud-rules';
const HOUR_MS = 60 * 60 * 1000;

export function createApp(
  config: FraudRulesConfig,
  extra: Partial<ConsumerServiceOptions> & { logDestination?: DestinationStream } = {},
) {
  const ruleset = loadRuleset(config.rulesFile);
  const repository = new RulesRepository(ruleset);
  return createConsumerService({
    service: SERVICE_NAME,
    schema: 'fraud_rules',
    config,
    readinessTopic: Topics.transactions,
    consumers: (deps) => [
      {
        group: ConsumerGroups.fraudRules,
        handlers: ruleHandlers({ ruleset, repository, outbox: deps.outbox }),
        // accounts.profiles.v1 is compacted: a null value deletes the profile.
        onTombstone: (accountId, tx) => repository.deleteProfile(tx, accountId),
      },
    ],
    jobs: (deps) => [
      {
        name: 'activity-cleanup',
        intervalMs: HOUR_MS,
        run: () => RulesRepository.cleanupActivity(deps.pool),
      },
    ],
    ...extra,
  });
}
