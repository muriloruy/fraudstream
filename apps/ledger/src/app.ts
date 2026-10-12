import { ConsumerGroups, Topics } from '@fraudstream/contracts';
import { createConsumerService, type ConsumerServiceOptions } from '@fraudstream/service-kit';
import { Ledger } from './application/posting.js';
import type { LedgerConfig } from './config/config.js';

export const SERVICE_NAME = 'ledger';

export function createApp(config: LedgerConfig, extra: Partial<ConsumerServiceOptions> = {}) {
  let ledger: Ledger | undefined;
  const ledgerFor = (deps: Parameters<ConsumerServiceOptions['consumers']>[0]) =>
    (ledger ??= new Ledger(deps.outbox, deps.registry));
  return createConsumerService({
    service: SERVICE_NAME,
    schema: 'ledger',
    config,
    readinessTopic: Topics.decisions,
    // Range assignment (runtime default) keeps partition N of transactions and decisions on
    // one instance, so the projection usually precedes the decision (ADR-002).
    consumers: (deps) => [{ group: ConsumerGroups.ledger, handlers: ledgerFor(deps).handlers() }],
    jobs: (deps) => [
      {
        name: 'projection-purge',
        intervalMs: 60 * 60 * 1000,
        run: () =>
          ledgerFor(deps).repository.purgeProjection(deps.pool, config.projectionRetentionMs),
      },
    ],
    ...extra,
  });
}
