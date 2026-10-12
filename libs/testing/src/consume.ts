import type { KafkaJS } from '@confluentinc/kafka-javascript';

type Kafka = KafkaJS.Kafka;

export interface ConsumedMessage {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  value: string | null;
  headers: Record<string, string>;
}

/**
 * Reads every message currently in `topics` from the beginning, using the admin API to
 * know the end offsets, so the call returns as soon as everything has been read.
 */
export async function readAll(
  kafka: Kafka,
  topics: readonly string[],
  timeoutMs = 30_000,
): Promise<ConsumedMessage[]> {
  const admin = kafka.admin();
  await admin.connect();
  const expected = new Map<string, bigint>();
  try {
    for (const topic of topics) {
      for (const p of await admin.fetchTopicOffsets(topic)) {
        const count = BigInt(p.high) - BigInt(p.low);
        if (count > 0n) expected.set(`${topic}/${p.partition}`, BigInt(p.high));
      }
    }
  } finally {
    await admin.disconnect();
  }
  if (expected.size === 0) return [];

  const consumer = kafka.consumer({
    kafkaJS: { groupId: `test-reader-${Date.now()}-${Math.random()}`, fromBeginning: true },
  });
  const messages: ConsumedMessage[] = [];
  await consumer.connect();
  try {
    await consumer.subscribe({ topics: [...topics] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`readAll timed out with ${messages.length} messages`));
      }, timeoutMs);
      void consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          const headers = Object.fromEntries(
            Object.entries(message.headers ?? {})
              .filter(
                (entry): entry is [string, NonNullable<(typeof entry)[1]>] =>
                  entry[1] !== undefined,
              )
              .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v.toString()]),
          );
          messages.push({
            topic,
            partition,
            offset: message.offset,
            key: message.key?.toString() ?? null,
            value: message.value?.toString() ?? null,
            headers,
          });
          const key = `${topic}/${partition}`;
          const high = expected.get(key);
          if (high !== undefined && BigInt(message.offset) + 1n >= high) expected.delete(key);
          if (expected.size === 0) {
            clearTimeout(timer);
            resolve();
          }
          return Promise.resolve();
        },
      });
    });
  } finally {
    await consumer.disconnect();
  }
  return messages;
}
