import { ConsumerGroups, Topics } from '@fraudstream/contracts';
import { createConsumerService, type ConsumerServiceOptions } from '@fraudstream/service-kit';
import { Decider } from './application/decider.js';
import type { DecisionConfig } from './config/config.js';

export const SERVICE_NAME = 'decision-engine';

export function createApp(config: DecisionConfig, extra: Partial<ConsumerServiceOptions> = {}) {
  let decider: Decider | undefined;
  const deciderFor = (deps: Parameters<ConsumerServiceOptions['consumers']>[0]) =>
    (decider ??= new Decider(config.fusion, deps.outbox, deps.registry));
  return createConsumerService({
    service: SERVICE_NAME,
    schema: 'decision',
    config,
    readinessTopic: Topics.decisions,
    // Range assignment (runtime default) keeps partition N of both inputs on one instance (ADR-002).
    consumers: (deps) => [
      { group: ConsumerGroups.decisionEngine, handlers: deciderFor(deps).handlers() },
    ],
    jobs: (deps) => [
      {
        name: 'join-timeout-sweeper',
        intervalMs: config.sweepIntervalMs,
        run: () => deciderFor(deps).sweep(deps.pool),
      },
    ],
    ...extra,
  });
}
