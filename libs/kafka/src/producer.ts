import { CompressionTypes, type Kafka, type Producer } from './client.js';

export interface OutgoingMessage {
  key: string;
  value: string;
  headers: Record<string, string>;
}

/**
 * Durable producer settings (SPEC §4.2): acks=all, idempotence (which also keeps per-partition
 * order with up to 5 in-flight requests), lz4 compression and a 5 ms linger for batching.
 */
export function createProducer(kafka: Kafka): Producer {
  return kafka.producer({
    kafkaJS: {
      idempotent: true,
      acks: -1,
      maxInFlightRequests: 5,
      compression: CompressionTypes.LZ4,
    },
    'linger.ms': 5,
  });
}

/** Sends messages to one topic and resolves once every message is acknowledged. */
export async function sendMessages(
  producer: Producer,
  topic: string,
  messages: readonly OutgoingMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  await producer.send({
    topic,
    messages: messages.map((m) => ({ key: m.key, value: m.value, headers: m.headers })),
  });
}
