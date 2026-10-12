/**
 * `pnpm dlq:replay --topic <dlq> --from <offset> --to <offset> [--partition <n>] [--dry-run]`
 *
 * Republishes a range of DLQ messages to their original topic (SPEC §4.6). Consumers are
 * idempotent, so replaying the same range twice is safe. Reads KAFKA_BROKERS from .env.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createKafka, createProducer, parseBrokers, replayDlq } from '@fraudstream/kafka';

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);

const { values } = parseArgs({
  options: {
    topic: { type: 'string' },
    from: { type: 'string', default: '0' },
    to: { type: 'string' },
    partition: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
if (!values.topic?.endsWith('.dlq') || values.to === undefined) {
  console.error(
    'usage: pnpm dlq:replay --topic <topic>.<group>.dlq --from <offset> --to <offset> [--partition <n>] [--dry-run]',
  );
  process.exit(2);
}

const kafka = createKafka({
  brokers: parseBrokers(process.env.KAFKA_BROKERS),
  clientId: 'dlq-replay',
});
const producer = createProducer(kafka);
await producer.connect();
try {
  const results = await replayDlq({
    kafka,
    producer,
    dlqTopic: values.topic,
    from: BigInt(values.from),
    to: BigInt(values.to),
    ...(values.partition === undefined ? {} : { partition: Number(values.partition) }),
    dryRun: values['dry-run'],
  });
  console.table(results);
  const done = results.filter((r) => r.replayed).length;
  console.log(
    values['dry-run']
      ? `dry run: ${results.length} message(s) would be replayed`
      : `replayed ${done} of ${results.length} message(s)`,
  );
} finally {
  await producer.disconnect();
}
