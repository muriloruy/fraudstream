import { ConsumerGroups, Topics } from '@fraudstream/contracts';
import { createConsumerService, type ConsumerServiceOptions } from '@fraudstream/service-kit';
import { anomalyHandlers } from './application/handlers.js';
import type { AnomalyConfig } from './config/config.js';
import { AnomalyRepository } from './infrastructure/db/anomaly.repository.js';

export const SERVICE_NAME = 'anomaly-scorer';

export function createApp(config: AnomalyConfig, extra: Partial<ConsumerServiceOptions> = {}) {
  const repository = new AnomalyRepository();
  return createConsumerService({
    service: SERVICE_NAME,
    schema: 'anomaly',
    config,
    readinessTopic: Topics.transactions,
    consumers: (deps) => [
      {
        group: ConsumerGroups.anomalyScorer,
        handlers: anomalyHandlers({
          repository,
          outbox: deps.outbox,
          alpha: config.alpha,
          logger: deps.logger,
        }),
        onTombstone: (accountId, tx) => repository.deleteProfile(tx, accountId),
      },
    ],
    ...extra,
  });
}
