import { Gauge, Histogram, type Registry } from '@fraudstream/observability';
import type { Pool } from '@fraudstream/db';
import { assertSchemaName } from './schema.js';

export interface RelayMetrics {
  publishDuration: Histogram;
}

/**
 * `outbox_lag_rows`, `outbox_oldest_unpublished_seconds` (read from the table on scrape, via
 * the partial unpublished index) and `outbox_publish_duration_ms` (SPEC §6.3, §10).
 */
export function createRelayMetrics(registry: Registry, pool: Pool, schema: string): RelayMetrics {
  const lagSql = `SELECT count(*)::int AS lag,
            COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::float8 AS oldest
       FROM ${assertSchemaName(schema)}.outbox WHERE published_at IS NULL`;
  let last = { lag: 0, oldest: 0 };
  const refresh = async () => {
    const { rows } = await pool.query<{ lag: number; oldest: number }>(lagSql);
    last = rows[0] ?? last;
  };

  new Gauge({
    name: 'outbox_lag_rows',
    help: 'Outbox rows not yet published to Kafka',
    labelNames: ['schema'],
    registers: [registry],
    async collect() {
      await refresh().catch(() => undefined);
      this.set({ schema }, last.lag);
    },
  });
  new Gauge({
    name: 'outbox_oldest_unpublished_seconds',
    help: 'Age of the oldest unpublished outbox row',
    labelNames: ['schema'],
    registers: [registry],
    collect() {
      this.set({ schema }, last.oldest);
    },
  });
  return {
    publishDuration: new Histogram({
      name: 'outbox_publish_duration_ms',
      help: 'Time to publish one outbox batch and receive all acks',
      buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
      registers: [registry],
    }),
  };
}
