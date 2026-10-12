import { createServer } from 'node:http';
import { createPool, databaseIsReachable } from '@fraudstream/db';
import { createKafka, createProducer } from '@fraudstream/kafka';
import { createLogger, createMetricsRegistry } from '@fraudstream/observability';
import { createRelayMetrics, OutboxRelay } from '@fraudstream/outbox';
import { loadConfig } from './config.js';

const SERVICE = 'outbox-relay';
const config = loadConfig();
const logger = createLogger({ service: SERVICE, level: config.logLevel });
const pool = createPool({
  connectionString: config.databaseUrl,
  applicationName: `${SERVICE}:${config.schema}`,
  max: 3,
  onIdleError: (err) => {
    logger.warn({ err: err.message }, 'idle database connection lost');
  },
});
const kafka = createKafka({
  brokers: config.kafkaBrokers,
  clientId: `${SERVICE}-${config.schema}`,
});
// Bound delivery time so a broker outage surfaces as a failed batch (retried with backoff)
// instead of a send that hangs for librdkafka's 5-minute default.
const producer = createProducer(kafka, { 'message.timeout.ms': config.deliveryTimeoutMs });
await producer.connect();

const registry = createMetricsRegistry(SERVICE);
const relay = new OutboxRelay({
  pool,
  producer,
  schema: config.schema,
  batchSize: config.batchSize,
  pollMs: config.pollMs,
  logger,
  metrics: createRelayMetrics(registry, pool, config.schema),
});
relay.start();
logger.info({ schema: config.schema, batchSize: config.batchSize }, 'outbox relay started');

const server = createServer((req, res) => {
  void (async () => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': registry.contentType }).end(await registry.metrics());
    } else if (req.url === '/health/live') {
      res.writeHead(200).end('ok');
    } else if (req.url === '/health/ready') {
      res.writeHead((await databaseIsReachable(pool)) ? 200 : 503).end();
    } else {
      res.writeHead(404).end();
    }
  })();
});
server.listen(config.metricsPort);

// Graceful shutdown (SPEC §4.3): finish the in-flight batch, release leadership, disconnect.
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  await relay.stop();
  await producer.disconnect();
  await pool.end();
  server.close();
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
