/**
 * A consumer process for lifecycle tests. MODE=slow: each handler takes 1.5 s (so SIGTERM
 * lands mid-message). MODE=crash: the handler kills the process before the DB transaction
 * commits, like a power cut. MODE=normal: plain processing.
 */
import { createPool } from '@fraudstream/db';
import { createKafka, createProducer } from '../index.js';
import { ConsumerRuntime, on } from '../consumer/runtime.js';
import { testEvent } from './test-event.js';

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const mode = env('MODE');
const pool = createPool({
  connectionString: env('DATABASE_URL'),
  applicationName: `child-${mode}`,
});
const kafka = createKafka({ brokers: env('KAFKA_BROKERS').split(','), clientId: `child-${mode}` });
const producer = createProducer(kafka);
await producer.connect();

const runtime = new ConsumerRuntime({
  kafka,
  pool,
  producer,
  group: env('GROUP'),
  schema: 'payments',
  handlers: [
    on(testEvent(env('TOPIC')), async (e, ctx) => {
      console.log(`PROCESSING ${e.eventId}`);
      await ctx.tx.query('INSERT INTO effects (event_id, key, n) VALUES ($1, $2, $3)', [
        e.eventId,
        e.payload.key,
        e.payload.n,
      ]);
      if (mode === 'crash') process.exit(1); // dies with the transaction still open
      if (mode === 'slow') await new Promise((r) => setTimeout(r, 1500));
      console.log(`HANDLED ${e.eventId}`);
    }),
  ],
});
await runtime.start();
console.log('STARTED');

process.once('SIGTERM', () => {
  void (async () => {
    await runtime.stop();
    await producer.disconnect();
    await pool.end();
    console.log('STOPPED');
    process.exit(0);
  })();
});
