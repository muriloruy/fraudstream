import { Counter, Histogram, type Registry } from '@fraudstream/observability';

export type Outcome = 'ok' | 'duplicate' | 'retry' | 'dlq';

export interface ConsumerMetrics {
  messages: Counter<'topic' | 'group' | 'outcome'>;
  processing: Histogram<'topic' | 'group'>;
}

const cache = new WeakMap<Registry, ConsumerMetrics>();

/** `kafka_consumer_messages_total` and `kafka_consumer_processing_seconds` (SPEC §10). */
export function consumerMetrics(registry: Registry): ConsumerMetrics {
  const existing = cache.get(registry);
  if (existing) return existing;
  const metrics: ConsumerMetrics = {
    messages: new Counter({
      name: 'kafka_consumer_messages_total',
      help: 'Messages handled by the consumer runtime, by outcome',
      labelNames: ['topic', 'group', 'outcome'],
      registers: [registry],
    }),
    processing: new Histogram({
      name: 'kafka_consumer_processing_seconds',
      help: 'Time to process one message, including in-process retries',
      labelNames: ['topic', 'group'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
  };
  cache.set(registry, metrics);
  return metrics;
}
